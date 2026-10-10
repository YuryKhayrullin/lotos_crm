#!/usr/bin/env python3
"""Offline, read-only XLSX inspection. No database, network, or source writes.

Python's standard library is used only for this operator tool, not the web app.
Formulae, macros, external references and instructions in cells are never run.
Reports contain counts, field names and physical row locations, not PII/hashes.
"""
import argparse
import collections
import datetime as dt
import decimal
import hashlib
import io
import json
import pathlib
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
MAX_FILE = 20 * 1024 * 1024
MAX_XML = 30 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024
REQUIRED = {
    "Users": ["id", "username", "password", "role", "branchId", "status"],
    "Филиалы": ["id", "name", "address"],
    "Тренеры": ["id", "name", "branchId", "userId"],
    "Клиенты": ["id", "childName", "parentName", "branchId", "status", "category", "lessonsPerWeek",
                "remainingLessons", "totalLessons", "paidAmount", "paymentBalance", "attendanceHistory"],
    "Расписание": ["id", "branchId", "coachName", "date", "time", "category", "isRecurring", "clientIds"],
    "Платежи": ["id", "requestId", "clientId", "branchId", "amount", "packagePrice", "packageLessons",
                "packagesCount", "lessonsAdded"],
    "Журнал занятий": ["id", "requestId", "clientId", "branchId", "paymentId", "type", "lessonsDelta",
                        "totalLessonsDelta", "balanceBefore", "balanceAfter", "totalLessonsBefore", "totalLessonsAfter"],
    "Посещения": ["id", "requestId", "lessonId", "date", "clientId", "status"],
    "Журнал администрирования": ["id", "requestId", "action", "entityType", "entityId", "actorId"],
}


class InspectionError(ValueError):
    pass


def xml(data):
    if len(data) > MAX_XML or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise InspectionError("UNSAFE_OR_OVERSIZED_XML")
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise InspectionError("INVALID_XML") from None


def text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, decimal.Decimal):
        return format(value.normalize(), "f")
    return str("" if value is None else value).strip()


def number(value, integer=False, money=False):
    if value is None or isinstance(value, bool) or not text(value):
        return None
    try:
        result = decimal.Decimal(text(value))
        if not result.is_finite() or (result and not -30 <= result.adjusted() <= 30):
            return None
        if (integer and result % 1) or (money and result * 100 % 1):
            return None
        return result
    except decimal.DecimalException:
        return None


def read_workbook(filename):
    source = pathlib.Path(filename)
    if source.stat().st_size > MAX_FILE:
        raise InspectionError("WORKBOOK_TOO_LARGE")
    payload = source.read_bytes()
    if len(payload) > MAX_FILE:
        raise InspectionError("WORKBOOK_TOO_LARGE")
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise InspectionError("INVALID_XLSX_ARCHIVE") from None
    with archive as z:
        members = z.infolist()
        names = [member.filename for member in members]
        if len(members) > 2000 or len(names) != len(set(names)):
            raise InspectionError("INVALID_ARCHIVE_ENTRIES")
        if sum(member.file_size for member in members) > MAX_TOTAL:
            raise InspectionError("UNCOMPRESSED_WORKBOOK_TOO_LARGE")
        if any(member.file_size > MAX_XML or member.flag_bits & 1 or
               (member.file_size > 1024 * 1024 and member.file_size > max(1, member.compress_size) * 200)
               for member in members):
            raise InspectionError("UNSAFE_ARCHIVE_ENTRY")
        if any(".." in pathlib.PurePosixPath(name).parts or name.startswith("/") or "\\" in name for name in names):
            raise InspectionError("UNSAFE_ARCHIVE_PATH")
        if any("vbaproject" in name.lower() for name in names):
            raise InspectionError("MACROS_NOT_SUPPORTED")
        if any(name.startswith("xl/externalLinks/") for name in names):
            raise InspectionError("EXTERNAL_WORKBOOK_LINKS")
        required_parts = ["xl/workbook.xml", "xl/_rels/workbook.xml.rels"]
        if any(name not in names for name in required_parts):
            raise InspectionError("MISSING_WORKBOOK_PART")
        workbook = xml(z.read("xl/workbook.xml"))
        properties = workbook.find("m:workbookPr", NS)
        date1904 = properties is not None and properties.attrib.get("date1904", "false") in ("1", "true")
        relationships = xml(z.read("xl/_rels/workbook.xml.rels"))
        targets = {}
        for relation in relationships:
            if relation.attrib.get("TargetMode") == "External":
                raise InspectionError("EXTERNAL_WORKBOOK_RELATIONSHIP")
            targets[relation.attrib["Id"]] = relation.attrib.get("Target", "")
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared = ["".join(node.text or "" for node in item.findall(".//m:t", NS))
                      for item in xml(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
        formats = []
        if "xl/styles.xml" in names:
            styles = xml(z.read("xl/styles.xml"))
            custom = {item.attrib["numFmtId"]: item.attrib.get("formatCode", "")
                      for item in styles.findall("m:numFmts/m:numFmt", NS)}
            formats = [(int(item.attrib.get("numFmtId", "0")), custom.get(item.attrib.get("numFmtId", "0"), ""))
                       for item in styles.findall("m:cellXfs/m:xf", NS)]
        result = {"sha256": hashlib.sha256(payload).hexdigest(), "date1904": date1904, "sheets": {}}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib["name"]
            if name in result["sheets"]:
                raise InspectionError("DUPLICATE_SHEET")
            target = targets.get(sheet.attrib.get(REL), "")
            part = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
            if not part.startswith("xl/worksheets/") or part not in names:
                raise InspectionError("INVALID_WORKSHEET_TARGET")
            content = xml(z.read(part))
            if content.find("m:hyperlinks", NS) is not None:
                # Never follow links, including links to a live CRM or files.
                pass
            headers, rows = {}, []
            formulas = 0
            seen_rows = set()
            for row in content.findall("m:sheetData/m:row", NS):
                position = int(row.attrib.get("r", "0"))
                if position < 1 or position in seen_rows or len(seen_rows) >= 50000:
                    raise InspectionError("INVALID_OR_OVERSIZED_ROWS")
                seen_rows.add(position)
                cells, styles_by_column, formula_columns = {}, {}, set()
                for cell in row.findall("m:c", NS):
                    reference = cell.attrib.get("r", "")
                    match = re.fullmatch(r"([A-Z]{1,3})([0-9]+)", reference)
                    if not match or int(match[2]) != position or match[1] in cells:
                        raise InspectionError("INVALID_CELL_REFERENCE")
                    column = match[1]
                    node = cell.find("m:v", NS)
                    value = node.text or "" if node is not None else ""
                    kind = cell.attrib.get("t", "n")
                    if kind == "e":
                        raise InspectionError("SPREADSHEET_ERROR_CELL")
                    if cell.find("m:f", NS) is not None:
                        formulas += 1
                        formula_columns.add(column)
                        value = None  # cached formula results are NOT confirmed source values
                    elif kind == "s":
                        index = int(value)
                        if index < 0 or index >= len(shared):
                            raise InspectionError("INVALID_SHARED_STRING")
                        value = shared[index]
                    elif kind == "inlineStr":
                        value = "".join(item.text or "" for item in cell.findall("m:is//m:t", NS))
                    elif kind == "b":
                        if value not in ("0", "1"):
                            raise InspectionError("INVALID_BOOLEAN")
                        value = value == "1"
                    elif kind == "n" and value:
                        try:
                            if len(value) > 200:
                                raise InspectionError("NUMBER_CELL_TOO_LARGE")
                            value = decimal.Decimal(value)
                            if not value.is_finite():
                                raise InspectionError("NONFINITE_CELL")
                            if value and not -30 <= value.adjusted() <= 30:
                                raise InspectionError("NUMBER_CELL_OUT_OF_RANGE")
                        except decimal.DecimalException:
                            raise InspectionError("INVALID_NUMBER_CELL") from None
                    elif kind not in ("n", "str", "d", "e"):
                        raise InspectionError("UNSUPPORTED_CELL_TYPE")
                    style = int(cell.attrib.get("s", "0"))
                    if style and style >= len(formats):
                        raise InspectionError("INVALID_CELL_STYLE")
                    styles_by_column[column] = formats[style] if formats else (0, "")
                    cells[column] = value
                if not any(value not in ("", None) for value in cells.values()) and not formula_columns:
                    continue
                if not headers:
                    headers = {column: text(value) for column, value in cells.items() if text(value)}
                    if formula_columns or len(headers.values()) != len(set(headers.values())):
                        raise InspectionError("INVALID_HEADERS")
                else:
                    rows.append({"row": position, "values": {header: cells.get(column, "") for column, header in headers.items()},
                                 "styles": {header: styles_by_column.get(column, (0, "")) for column, header in headers.items()},
                                 "formulaFields": [headers.get(column, "unknown") for column in formula_columns]})
            result["sheets"][name] = {"headers": list(headers.values()), "rows": rows, "formulaCells": formulas}
        return result


def date_only(value, style=(0, ""), date1904=False):
    if isinstance(value, decimal.Decimal):
        numeric_format, format_code = style
        if numeric_format not in (14, 15, 16, 17, 22) and not re.search(r"[dy]", format_code, re.I):
            return None  # do not guess that a General number means a calendar date
        if value % 1 or value < 0 or value > 2958465 or (not date1904 and value == 60):
            return None
        epoch = dt.date(1904, 1, 1) if date1904 else dt.date(1899, 12, 31)
        return (epoch + dt.timedelta(days=int(value) - (0 if date1904 or value < 60 else 1))).isoformat()
    value = text(value)
    for pattern in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            parsed = dt.datetime.strptime(value, pattern)
            return parsed.date().isoformat()
        except ValueError:
            continue
    return None


def clock(value):
    if isinstance(value, decimal.Decimal):
        if value < 0 or value >= 1:
            return None
        minute = value * 1440
        rounded = int(minute.to_integral_value(rounding=decimal.ROUND_HALF_UP))
        if abs(minute - rounded) > decimal.Decimal("0.00001") or rounded >= 1440:
            return None
        return f"{rounded // 60:02}:{rounded % 60:02}"
    match = re.fullmatch(r"([0-9]{1,2}):([0-9]{2})", text(value))
    return f"{int(match[1]):02}:{match[2]}" if match and int(match[1]) < 24 and int(match[2]) < 60 else None


def ids(value):
    value = text(value)
    if not value:
        return None  # historical/unknown, NOT explicit empty []
    if value.startswith("["):
        try:
            result = json.loads(value)
            if not isinstance(result, list) or any(not isinstance(item, str) or not item.strip() for item in result):
                return False
            return [item.strip() for item in result]
        except ValueError:
            return False
    return [item.strip() for item in value.split(",") if item.strip()]


def inspect(workbook):
    report = {"reportVersion": 1, "mode": "read-only", "sourceSha256": workbook["sha256"],
              "readyForImport": False, "counts": {}, "errors": [], "warnings": [], "accounting": [],
              "schedule": [], "privacy": {}, "attendance": {}, "normalizations": {}}
    sheets = workbook["sheets"]
    def issue(code, sheet=None, row=None, field=None, warning=False):
        item = {"code": code}
        if sheet in REQUIRED or sheet == "Создание занятий":
            item["sheet"] = sheet
        if row is not None:
            item["row"] = row
        if field is not None:
            item["field"] = field
        report["warnings" if warning else "errors"].append(item)
    for name, fields in REQUIRED.items():
        source = sheets.get(name)
        if source is None:
            issue("MISSING_SHEET", name)
            continue
        report["counts"][name] = len(source["rows"])
        for field in fields:
            if field not in source["headers"]:
                issue("MISSING_COLUMN", name, field=field)
        for row in source["rows"]:
            for field in row["formulaFields"]:
                issue("FORMULA_VALUE_NOT_CONFIRMED", name, row["row"], field if field in fields else None)
    if "Создание занятий" in sheets:
        report["counts"]["Создание занятий"] = len(sheets["Создание занятий"]["rows"])
    def records(name):
        return sheets.get(name, {}).get("rows", [])
    indexes = {}
    for name in REQUIRED:
        index = {}
        for row in records(name):
            key = text(row["values"].get("id"))
            if not key:
                issue("MISSING_ID", name, row["row"], "id")
            elif key in index:
                issue("DUPLICATE_ID", name, row["row"], "id")
            else:
                index[key] = row
            raw = row["values"].get("id")
            if isinstance(raw, decimal.Decimal) and (raw % 1 or len(text(raw).lstrip("-")) > 15):
                issue("NUMERIC_ID_PRECISION_UNCONFIRMED", name, row["row"], "id")
        indexes[name] = index
    branches, clients, users, lessons = (indexes[name] for name in ("Филиалы", "Клиенты", "Users", "Расписание"))
    for name in ("Users", "Тренеры", "Клиенты", "Расписание", "Платежи", "Журнал занятий"):
        for row in records(name):
            branch = text(row["values"].get("branchId"))
            optional = name == "Users" and text(row["values"].get("role")) in ("1", "admin")
            if (not branch and not optional) or (branch and branch not in branches):
                issue("MISSING_BRANCH_REFERENCE", name, row["row"], "branchId")
    for row in records("Филиалы"):
        if not text(row["values"].get("timeZone")):
            issue("BRANCH_TIMEZONE_REQUIRES_CONFIRMATION", "Филиалы", row["row"], "timeZone")
    credentials = 0
    usernames = set()
    for row in records("Users"):
        value = row["values"]
        credentials += bool(text(value.get("password")))
        username = text(value.get("username")).lower()
        if not username or username in usernames:
            issue("MISSING_OR_DUPLICATE_USERNAME", "Users", row["row"], "username")
        usernames.add(username)
        if text(value.get("role")) not in ("1", "2", "admin", "coach"):
            issue("INVALID_ROLE", "Users", row["row"], "role")
    report["privacy"] = {"nonemptyPasswordCells": credentials, "passwordValuesReported": False}
    if credentials:
        issue("PASSWORD_TRANSFER_POLICY_UNAPPROVED", "Users")
        issue("SOURCE_HAS_CREDENTIAL_HASHES_KEEP_PRIVATE", "Users", warning=True)
    linked_users = set()
    for row in records("Тренеры"):
        value = row["values"]; user_id = text(value.get("userId"))
        if user_id:
            user = users.get(user_id)
            if not user or text(user["values"].get("role")) not in ("2", "coach"):
                issue("INVALID_COACH_ACCOUNT_REFERENCE", "Тренеры", row["row"], "userId")
            elif text(user["values"].get("branchId")) != text(value.get("branchId")):
                issue("COACH_ACCOUNT_BRANCH_MISMATCH", "Тренеры", row["row"], "userId")
            if user_id in linked_users:
                issue("DUPLICATE_COACH_ACCOUNT_LINK", "Тренеры", row["row"], "userId")
            linked_users.add(user_id)
    report["accountsWithoutCoachProfile"] = sum(text(row["values"].get("role")) in ("2", "coach") and key not in linked_users for key, row in users.items())
    # Card assignments are evidence, not permission to enroll an entire branch.
    assigned = collections.defaultdict(set)
    for key, row in clients.items():
        values = ids(row["values"].get("assignedLessonIds") or row["values"].get("assignedLessonId"))
        if values is False:
            issue("INVALID_CLIENT_ASSIGNMENTS", "Клиенты", row["row"], "assignedLessonIds")
        for lesson_id in values or []:
            if lesson_id not in lessons:
                issue("MISSING_ASSIGNED_LESSON", "Клиенты", row["row"], "assignedLessonIds")
            else:
                assigned[lesson_id].add(key)
    for key, row in lessons.items():
        value = row["values"]; branch = text(value.get("branchId"))
        name = text(value.get("coachName"))
        candidates = set()
        for profile_id, profile in indexes["Тренеры"].items():
            p = profile["values"]
            if name and text(p.get("name")) == name and text(p.get("branchId")) == branch:
                candidates.add("user:" + text(p["userId"]) if text(p.get("userId")) else "profile:" + profile_id)
        for user_id, user in users.items():
            u = user["values"]
            if name and text(u.get("username")) == name and text(u.get("role")) in ("2", "coach") and text(u.get("branchId")) == branch:
                candidates.add("user:" + user_id)
        issue("LESSON_COACH_LINK_REQUIRES_CONFIRMATION" if len(candidates) == 1 else "LESSON_COACH_UNRESOLVED",
              "Расписание", row["row"], "coachName")
        date = date_only(value.get("date"), row["styles"].get("date", (0, "")), workbook["date1904"])
        time = clock(value.get("time"))
        if not date:
            issue("INVALID_OR_AMBIGUOUS_LESSON_DATE", "Расписание", row["row"], "date")
        if not time:
            issue("INVALID_OR_AMBIGUOUS_LESSON_TIME", "Расписание", row["row"], "time")
        roster = ids(value.get("clientIds"))
        if roster is False:
            issue("INVALID_ROSTER", "Расписание", row["row"], "clientIds")
        elif roster is None:
            issue("HISTORICAL_ROSTER_UNCONFIRMED", "Расписание", row["row"], "clientIds")
        else:
            if len(roster) != len(set(roster)):
                issue("DUPLICATE_ROSTER_CLIENT", "Расписание", row["row"], "clientIds")
            if set(roster) != assigned[key]:
                issue("ROSTER_ASSIGNMENT_DISAGREEMENT", "Расписание", row["row"], "clientIds")
            for client_id in roster:
                client = clients.get(client_id)
                if not client:
                    issue("MISSING_ROSTER_CLIENT", "Расписание", row["row"], "clientIds")
                elif text(client["values"].get("branchId")) != branch:
                    issue("CROSS_BRANCH_ROSTER", "Расписание", row["row"], "clientIds")
                elif text(client["values"].get("category")) != text(value.get("category")):
                    issue("ROSTER_CATEGORY_MISMATCH", "Расписание", row["row"], "clientIds")
        report["schedule"].append({"row": row["row"], "date": date, "time": time, "coachCandidates": len(candidates),
                                   "rosterKind": "invalid" if roster is False else "historicalUnknown" if roster is None else "explicit",
                                   "rosterCount": len(roster) if isinstance(roster, list) else 0})
    ledger_by_client, payments_by_client = collections.defaultdict(list), collections.defaultdict(list)
    for name, target in (("Журнал занятий", ledger_by_client), ("Платежи", payments_by_client)):
        for row in records(name):
            value = row["values"]; client = clients.get(text(value.get("clientId")))
            if not client:
                issue("MISSING_ACCOUNTING_CLIENT", name, row["row"], "clientId")
            elif text(client["values"].get("branchId")) != text(value.get("branchId")):
                issue("ACCOUNTING_BRANCH_MISMATCH", name, row["row"], "branchId")
            target[text(value.get("clientId"))].append(row)
    history_count, missing_history_context, incomplete_history, receipt_refs = 0, 0, 0, 0
    for key, row in clients.items():
        value = row["values"]; remaining = number(value.get("remainingLessons"), True); total = number(value.get("totalLessons"), True)
        if remaining is None or total is None or not 0 <= remaining <= total:
            issue("INVALID_CARD_CREDITS", "Клиенты", row["row"])
        paid = number(value.get("paidAmount"), money=True); wallet = number(value.get("paymentBalance"), money=True)
        for field, amount in (("paidAmount", paid), ("paymentBalance", wallet)):
            if amount is None or amount < 0:
                issue("UNCONFIRMED_OR_INVALID_CARD_MONEY", "Клиенты", row["row"], field)
        balance, purchased, invalid_ledger = decimal.Decimal(0), decimal.Decimal(0), False
        for movement in ledger_by_client[key]:
            item = movement["values"]
            fields = ["lessonsDelta", "totalLessonsDelta", "balanceBefore", "balanceAfter", "totalLessonsBefore", "totalLessonsAfter"]
            numbers = {field: number(item.get(field), True) for field in fields}
            if any(n is None for n in numbers.values()):
                issue("INVALID_LEDGER_NUMBER", "Журнал занятий", movement["row"]); invalid_ledger = True; continue
            if numbers["balanceBefore"] != balance or numbers["totalLessonsBefore"] != purchased:
                issue("LEDGER_BEFORE_MISMATCH", "Журнал занятий", movement["row"]); invalid_ledger = True
            balance += numbers["lessonsDelta"]; purchased += numbers["totalLessonsDelta"]
            if not 0 <= balance <= purchased or numbers["balanceAfter"] != balance or numbers["totalLessonsAfter"] != purchased:
                issue("LEDGER_AFTER_OR_INVARIANT_MISMATCH", "Журнал занятий", movement["row"]); invalid_ledger = True
            if text(item.get("type")) in ("purchase", "purchase_repair") and text(item.get("paymentId")) not in indexes["Платежи"]:
                issue("PURCHASE_WITHOUT_CONFIRMED_PAYMENT", "Журнал занятий", movement["row"]); invalid_ledger = True
        if remaining != balance or total != purchased:
            issue("CARD_LEDGER_DISCREPANCY", "Клиенты", row["row"])
        confirmed, unspent = decimal.Decimal(0), decimal.Decimal(0)
        for payment in payments_by_client[key]:
            item = payment["values"]
            amount = number(item.get("amount"), money=True); price = number(item.get("packagePrice"), money=True)
            packages = number(item.get("packagesCount"), True); package_lessons = number(item.get("packageLessons"), True); added = number(item.get("lessonsAdded"), True)
            if any(n is None or n <= 0 for n in (amount, price, packages, package_lessons, added)) or packages * package_lessons != added:
                issue("INVALID_CONFIRMED_PAYMENT", "Платежи", payment["row"]); continue
            confirmed += amount; unspent += amount - price * packages
            links = [m for m in ledger_by_client[key] if text(m["values"].get("paymentId")) == text(item.get("id"))]
            if len(links) != 1 or number(links[0]["values"].get("lessonsDelta"), True) != added:
                issue("PAYMENT_LEDGER_LINK_MISMATCH", "Платежи", payment["row"])
        if paid is not None and paid != confirmed:
            issue("MONEY_WITHOUT_CONFIRMED_PAYMENTS", "Клиенты", row["row"], "paidAmount")
        if wallet is not None and (wallet != unspent or wallet < 0):
            issue("WALLET_NOT_CONFIRMED_BY_PAYMENTS", "Клиенты", row["row"], "paymentBalance")
        try:
            history = json.loads(text(value.get("attendanceHistory")) or "[]")
            if not isinstance(history, list) or any(not isinstance(mark, dict) for mark in history):
                raise ValueError()
        except ValueError:
            history = []; issue("INVALID_ATTENDANCE_HISTORY", "Клиенты", row["row"], "attendanceHistory")
        history_count += len(history)
        attended = 0
        seen = set()
        for mark in history:
            lesson_id = text(mark.get("lessonId")); lesson = lessons.get(lesson_id); date = date_only(mark.get("date"))
            status = text(mark.get("status")); attended += status == "attended"
            if not lesson:
                missing_history_context += 1
                issue("HISTORICAL_ATTENDANCE_WITHOUT_LESSON", "Клиенты", row["row"], "attendanceHistory")
            else:
                l = lesson["values"]
                expected_date = date_only(l.get("date"), lesson["styles"].get("date", (0, "")), workbook["date1904"])
                if date != expected_date and text(l.get("isRecurring")) not in ("true", "1"):
                    issue("HISTORY_OCCURRENCE_DATE_MISMATCH", "Клиенты", row["row"], "attendanceHistory")
                if text(l.get("branchId")) != text(value.get("branchId")):
                    issue("HISTORY_BRANCH_MISMATCH", "Клиенты", row["row"], "attendanceHistory")
            if not date or status not in ("attended", "absent"):
                issue("INVALID_HISTORY_DATE_OR_STATUS", "Клиенты", row["row"], "attendanceHistory")
            if not text(mark.get("requestId")) or not text(mark.get("recordedBy")):
                incomplete_history += 1
                issue("HISTORICAL_ATTENDANCE_PROVENANCE_INCOMPLETE", "Клиенты", row["row"], "attendanceHistory")
            # Without lesson identity two same-day entries are NOT safely deduplicable.
            if lesson_id and date:
                identity = (lesson_id, date)
                if identity in seen:
                    issue("DUPLICATE_CURRENT_ATTENDANCE" if lesson else "REPEATED_UNRESOLVED_HISTORY_IDENTITY",
                          "Клиенты", row["row"], "attendanceHistory", warning=not bool(lesson))
                seen.add(identity)
        if remaining is not None and total is not None and attended != total - remaining:
            issue("HISTORY_COUNT_NOT_EQUAL_TO_SPENT_CREDITS", "Клиенты", row["row"], "attendanceHistory", warning=True)
        receipt_refs += bool(text(value.get("receiptUrl")))
        report["accounting"].append({"clientRow": row["row"], "remainingLessons": int(remaining) if remaining is not None else None,
                                     "totalLessons": int(total) if total is not None else None,
                                     "ledgerRemaining": int(balance), "ledgerTotal": int(purchased),
                                     "creditsMatch": not invalid_ledger and remaining == balance and total == purchased,
                                     "cardPaidAmount": str(paid) if paid is not None else None,
                                     "confirmedPaymentAmount": str(confirmed), "historyMarks": len(history)})
    report["attendance"] = {"cardHistoryMarks": history_count, "marksWithoutLesson": missing_history_context,
                            "marksWithoutRequestOrActor": incomplete_history, "receiptReferences": receipt_refs}
    report["normalizations"] = {"dateSystem": "1904" if workbook["date1904"] else "1900",
                                "numericRolesAndIds": "exact integer text, not floating suffix .0",
                                "serialDates": "only recognized date formats, without host timezone",
                                "numericRosters": "single legacy ID, not invalid JSON array"}
    if "Создание занятий" not in sheets:
        issue("LESSON_CREATION_JOURNAL_ABSENT", "Создание занятий", warning=True)
    if receipt_refs:
        issue("DOCUMENT_FILES_AND_MANIFEST_REQUIRED", "Клиенты")
    # This tool never applies data and cannot certify write-side idempotency.
    report["sourceChecksPassed"] = not report["errors"]
    report["importImplementationVerified"] = False
    report["readyForImport"] = False
    return report


def main():
    parser = argparse.ArgumentParser(description="Read-only, sanitized XLSX migration inspection; never writes a database")
    parser.add_argument("workbook")
    parser.add_argument("--emit-test-plan",action="store_true",help="Private plan for the local/test importer; contains source data but NEVER credentials")
    parser.add_argument("--namespace",default="gas-test-2026-10-08")
    args = parser.parse_args()
    try:
        workbook=read_workbook(args.workbook)
        report = inspect(workbook)
        if args.emit_test_plan:
            if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{2,79}',args.namespace):
                raise InspectionError('INVALID_NAMESPACE')
            allowed={'BRANCH_TIMEZONE_REQUIRES_CONFIRMATION','PASSWORD_TRANSFER_POLICY_UNAPPROVED','LESSON_COACH_UNRESOLVED','LESSON_COACH_LINK_REQUIRES_CONFIRMATION','HISTORICAL_ROSTER_UNCONFIRMED','UNCONFIRMED_OR_INVALID_CARD_MONEY','MONEY_WITHOUT_CONFIRMED_PAYMENTS','WALLET_NOT_CONFIRMED_BY_PAYMENTS','HISTORICAL_ATTENDANCE_WITHOUT_LESSON','HISTORICAL_ATTENDANCE_PROVENANCE_INCOMPLETE','INVALID_HISTORY_DATE_OR_STATUS'}
            if any(item['code'] not in allowed for item in report['errors']):
                raise InspectionError('SOURCE_STRUCTURAL_ERRORS_BLOCK_PLAN')
            records=[]
            for sheet,content in workbook['sheets'].items():
                if sheet not in REQUIRED and sheet!='Создание занятий':
                    raise InspectionError('UNRECOGNIZED_SHEET_REQUIRES_POLICY')
                for row in content['rows']:
                    values={key:text(value) for key,value in row['values'].items() if not re.search(r'password|secret|token|signature',key,re.I)}
                    records.append({'sheet':sheet,'sourceId':text(row['values'].get('id')) or 'row:'+str(row['row']),'row':row['row'],'values':values,
                                    'dateIso':date_only(row['values'].get('date'),row['styles'].get('date',(0,'')),workbook['date1904']),
                                    'birthDateIso':date_only(row['values'].get('birthDate'),row['styles'].get('birthDate',(0,'')),workbook['date1904']),
                                    'time':clock(row['values'].get('time'))})
            print(json.dumps({'version':1,'testOnly':True,'namespace':args.namespace,'sourceSha256':workbook['sha256'],'timeZone':'Europe/Moscow','skipLegacyFinance':True,'credentialPolicy':'disabled-reset-required','records':records,'coachBindings':{},'rosters':{}},ensure_ascii=False))
            return 0
    except (InspectionError, OSError, KeyError, IndexError, ValueError, zipfile.BadZipFile, OverflowError) as error:
        # Never print raw exception messages containing paths/cell contents.
        code = str(error) if isinstance(error, InspectionError) else "WORKBOOK_READ_FAILED"
        print(json.dumps({"reportVersion": 1, "mode": "read-only", "readyForImport": False,
                          "errors": [{"code": code}]}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["sourceChecksPassed"] else 2


if __name__ == "__main__":
    sys.exit(main())
