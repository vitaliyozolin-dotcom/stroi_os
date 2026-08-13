import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const script = readFileSync(new URL('../scripts/setup-telegram.sh', import.meta.url), 'utf8')

test('Telegram setup interpolates runtime values instead of sending shell placeholders', () => {
  assert.doesNotMatch(script, /\\\$\{/)
  assert.match(script, /bot\$\{IKIOMA_TELEGRAM_TOKEN\}\/getMe/)
  assert.match(script, /\$\{IKIOMA_PUBLIC_URL%\/\}\/api\/integrations\/telegram\/update/)
  assert.match(script, /test "\$\{STATUS:-\}" = "healthy"/)
})
