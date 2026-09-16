import { LayoutDashboard, CalendarDays, UsersRound, UserRound, CreditCard, CircleDollarSign, LucideIcon } from 'lucide-react'

export interface NavItem {
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS = [
  { name: 'Дашборд', icon: LayoutDashboard, screen: 'Дашборд' },
  { name: 'Клиенты и дети', icon: UsersRound, screen: 'Клиенты и дети' },
  { name: 'Тренеры', icon: UserRound, screen: 'Тренеры' },
  { name: 'Расписание', icon: CalendarDays, screen: 'Расписание' },
  { name: 'Абонементы', icon: CreditCard, screen: 'Абонементы' },
  { name: 'Финансы', icon: CircleDollarSign, screen: 'Финансы' },
]

export const nav: NavItem[] = NAV_ITEMS.map((item) => ({
  label: item.screen,
  icon: item.icon,
}))

