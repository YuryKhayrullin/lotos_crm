'use client'

import { getStore } from '@/store/RootStore'
import { observer } from 'mobx-react-lite'
import { 
  AppBar, 
  Toolbar, 
  IconButton, 
  Typography, 
  Button, 
  Box, 
  Avatar, 
  Menu, 
  MenuItem, 
  Divider 
} from '@mui/material'
import { 
  Menu as MenuIcon, 
  AccountCircle 
} from '@mui/icons-material'
import { useState } from 'react'

export const Header = observer(() => {
  const store = getStore()
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)

  const handleMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
  }

  const handleClose = () => {
    setAnchorEl(null)
  }

  return (
    <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', color: 'text.primary' }}>
      <Toolbar>
        <IconButton
          color="inherit"
          aria-label="open drawer"
          edge="start"
          onClick={store.toggleSidebar}
          sx={{ mr: 2, display: { sm: 'none' } }}
        >
          <MenuIcon />
        </IconButton>
        
        <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontWeight: 600 }}>
          {store.currentBranch?.name || 'Выберите филиал'}
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton
            size="large"
            aria-label="account of current user"
            aria-controls="menu-appbar"
            aria-haspopup="true"
            onClick={handleMenu}
            color="inherit"
          >
            <Avatar sx={{ bgcolor: 'primary.main', width: 32, height: 32, fontSize: '0.875rem' }}>
              {store.auth?.isAuthenticated ? store.auth.userInitials : 'ВХ'}
            </Avatar>
          </IconButton>
          <Menu
            id="menu-appbar"
            anchorEl={anchorEl}
            anchorOrigin={{
              vertical: 'bottom',
              horizontal: 'right',
            }}
            keepMounted
            transformOrigin={{
              vertical: 'top',
              horizontal: 'right',
            }}
            open={Boolean(anchorEl)}
            onClose={handleClose}
          >
            <MenuItem disabled sx={{ opacity: '1 !important', fontWeight: 600 }}>
              {store.auth?.isAuthenticated ? store.auth.username : 'Гость'}
            </MenuItem>
            <Divider />
            {store.auth?.isAuthenticated ? (
              <MenuItem onClick={() => { handleClose(); store.auth?.logout(); }}>Выйти</MenuItem>
            ) : (
              <MenuItem onClick={() => { handleClose(); store.openLogin(); }}>Войти</MenuItem>
            )}
          </Menu>
        </Box>
      </Toolbar>
    </AppBar>
  )
})
