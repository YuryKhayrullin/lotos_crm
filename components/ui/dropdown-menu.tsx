import * as React from "react"

export function DropdownMenu({ children, open, onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) { return <>{children}</> }
export function DropdownMenuContent({ children, align, className }: { children: React.ReactNode; align?: string; className?: string }) { return <div>{children}</div> }
export function DropdownMenuItem({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) { return <button onClick={onClick}>{children}</button> }
export function DropdownMenuLabel({ children }: { children: React.ReactNode }) { return <div>{children}</div> }
export function DropdownMenuSeparator() { return <hr /> }
export function DropdownMenuTrigger({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) { return <>{children}</> }
