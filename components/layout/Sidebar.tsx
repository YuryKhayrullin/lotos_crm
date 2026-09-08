'use client'

import { getStore } from '@/store/RootStore'
import { observer } from 'mobx-react-lite'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NAV_ITEMS } from '@/lib/constants/nav'

export const Sidebar = observer(() => {
  const store = getStore()

  return (
    <aside className="fixed inset-y-0 left-0 z-10 hidden w-64 flex-col border-r bg-background sm:flex">
      <nav className="flex flex-col items-center gap-4 px-2 py-4">
        <TooltipProvider>
          {NAV_ITEMS.map((item) => (
            <Tooltip key={item.name}>
              <TooltipTrigger>
                <Link
                  href="#"
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground md:h-8 md:w-8',
                    store.currentScreen === item.screen && 'bg-accent text-accent-foreground'
                  )}
                  onClick={() => store.setScreen(item.screen)}
                >
                  <item.icon className="h-5 w-5" />
                  <span className="sr-only">{item.name}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{item.name}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </nav>
      <div className="mt-auto p-4">
        <DropdownMenu open={store.branchMenuOpen} onOpenChange={store.toggleBranchMenu}>
          <DropdownMenuTrigger>
            <Button variant="outline" className="flex items-center gap-2 w-full">
              {store.currentBranch?.name || 'Выберите филиал'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[calc(100%-2rem)]">
            <DropdownMenuLabel>Филиалы</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {store.branches.map((branch) => (
              <DropdownMenuItem key={branch.id} onClick={() => store.setBranch(branch.id)}>
                {branch.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  )
})
