import { spawn } from 'node:child_process'

// Non-interactive operator commands only. Each invocation owns its process
// group; timeout/cancellation also kills lingering schema-engine children.
export function runBoundedCommand(command, args, { cwd, env, timeoutMs, killAfterMs = 2000, stdio = 'inherit' }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Finite command timeout required')
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, { cwd, env, stdio, detached: grouped })
    let timedOut = false
    let interrupted = false
    let killTimer
    let done = false
    const signal = (name) => {
      if (!child.pid) return
      try {
        if (grouped) process.kill(-child.pid, name)
        else child.kill(name)
      } catch {
        /* Already exited. Never target a different process/group. */
      }
    }
    const cancel = (name) => {
      if (done) return
      signal(name)
      if (!killTimer) killTimer = setTimeout(() => signal('SIGKILL'), killAfterMs)
    }
    const onInterrupt = () => {
      interrupted = true
      cancel('SIGINT')
    }
    const onTerminate = () => {
      interrupted = true
      cancel('SIGTERM')
    }
    const timer = setTimeout(() => {
      timedOut = true
      cancel('SIGTERM')
    }, timeoutMs)
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    const finish = (status, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (timedOut || interrupted) signal('SIGKILL')
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      resolve({ status, error, timedOut, interrupted })
    }
    child.once('error', (error) => finish(null, error))
    child.once('close', (status) => finish(status))
  })
}
