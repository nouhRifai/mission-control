import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const apiRoot = path.join(root, 'src', 'app', 'api')

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

function replaceAwait(content) {
  const patterns = [
    'requireRole',
    'getUserFromRequest',
    'authenticateUser',
    'createSession',
    'destroySession',
    'destroyAllUserSessions',
    'createUser',
    'updateUser',
    'deleteUser',
    'getUserById',
    'getAllUsers',
  ]

  let out = content
  for (const name of patterns) {
    const re = new RegExp(`(?<!await\\s)\\b${name}\\(`, 'g')
    out = out.replace(re, `await ${name}(`)
  }
  return out
}

const files = walk(apiRoot).filter((file) => file.endsWith('route.ts'))
let changed = 0

for (const file of files) {
  const before = fs.readFileSync(file, 'utf8')
  const after = replaceAwait(before)
  if (after !== before) {
    fs.writeFileSync(file, after)
    changed += 1
  }
}

console.log(`Updated ${changed}/${files.length} route handlers`)
