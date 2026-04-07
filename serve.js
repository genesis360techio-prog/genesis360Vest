const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 3000
const DIR = __dirname

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }

const server = http.createServer((req, res) => {
  let filePath = path.join(DIR, req.url === '/' ? '/preview.html' : req.url)
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' })
    res.end(data)
  })
})

server.listen(PORT, () => console.log(`\n  Genesis360 preview: http://localhost:${PORT}/preview.html\n`))
