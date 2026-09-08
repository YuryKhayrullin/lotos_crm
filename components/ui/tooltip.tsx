import * as React from "react"

export function Tooltip({ children }: { children: React.ReactNode }) { return <>{children}</> }
export function TooltipContent({ children, side }: { children: React.ReactNode; side?: string }) { return <div>{children}</div> }
export function TooltipProvider({ children }: { children: React.ReactNode }) { return <>{children}</> }
export function TooltipTrigger({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) { return <>{children}</> }
