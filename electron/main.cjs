/** @type {typeof import('electron')} */
const electron = require('electron')
const { app, BrowserWindow, shell, dialog } = electron
/** @type {typeof import('node:http')} */
const http = require('node:http')
const { createServer } = http
/** @type {typeof import('node:fs/promises')} */
const fs = require('node:fs/promises')
const { readFile, stat } = fs
/** @type {typeof import('node:path')} */
const path = require('node:path')

const HOST = '127.0.0.1'
const PORT = 4179
const DIST_DIR = path.resolve(__dirname, '..', 'dist')
const INDEX_FILE = path.join(DIST_DIR, 'index.html')
const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
})

/** @type {import('node:http').Server | undefined} */
let server

/** @returns {Promise<void>} */
function startLocalServer() {
  server = createServer(/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */ async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname)
    } catch {
      response.writeHead(400).end()
      return
    }

    const requestedPath = path.resolve(DIST_DIR, `.${pathname}`)
    if (requestedPath !== DIST_DIR && !requestedPath.startsWith(`${DIST_DIR}${path.sep}`)) {
      response.writeHead(403).end()
      return
    }

    let filePath = requestedPath
    try {
      if (!(await stat(filePath)).isFile()) filePath = INDEX_FILE
    } catch {
      if (path.extname(pathname)) {
        response.writeHead(404).end()
        return
      }
      filePath = INDEX_FILE
    }

    try {
      const contents = await readFile(filePath)
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': filePath === INDEX_FILE ? 'no-cache' : 'public, max-age=31536000, immutable',
      })
      response.end(request.method === 'HEAD' ? undefined : contents)
    } catch {
      response.writeHead(500).end()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      server.removeListener('error', reject)
      resolve(undefined)
    })
  })
}

/** @param {string} url */
function openExternal(url) {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'mailto:') {
      shell.openExternal(parsedUrl.href)
    }
  } catch {
    // Ignore malformed navigation targets.
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const appUrl = `http://${HOST}:${PORT}`
  const appOrigin = new URL(appUrl).origin
  window.webContents.setWindowOpenHandler(/** @param {{ url: string }} details */ ({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (/** @type {import('electron').Event} */ event, /** @type {string} */ url) => {
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault()
      openExternal(url)
    }
  })
  window.loadURL(appUrl)
}

app.whenReady().then(async () => {
  try {
    await stat(INDEX_FILE)
    await startLocalServer()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('tengaPOS could not start', message || 'The desktop app failed to start.')
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  server?.close()
})
