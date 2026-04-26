/**
 * One-shot script to derive Polymarket CLOB L2 API credentials from a wallet private key.
 * Run inside the backend Docker container where @polymarket/clob-client is installed:
 *
 *   docker exec -e PRIVATE_KEY=0x... polymarket-nest-backend \
 *     node /app/scripts/derive-clob-keys.mjs
 *
 * Outputs the four env vars to inject into SSM — nothing is written to disk.
 */

import { ClobClient, Chain } from '@polymarket/clob-client'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

const PRIVATE_KEY = process.env.PRIVATE_KEY
if (!PRIVATE_KEY) {
  console.error('ERROR: PRIVATE_KEY env var is required')
  process.exit(1)
}

const account = privateKeyToAccount(PRIVATE_KEY)
const walletClient = createWalletClient({ account, chain: polygon, transport: http() })

const client = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, walletClient)

console.error(`Deriving CLOB L2 keys for wallet: ${account.address}`)
console.error('Calling createOrDeriveApiCreds — this may take a few seconds...')

try {
  const creds = await client.createOrDeriveApiKey()
  // Print as export-ready lines — safe to pipe directly into SSM put-parameter commands
  console.log(`CLOB_WALLET_PRIVATE_KEY=${PRIVATE_KEY}`)
  console.log(`CLOB_API_KEY=${creds.key}`)
  console.log(`CLOB_API_SECRET=${creds.secret}`)
  console.log(`CLOB_API_PASSPHRASE=${creds.passphrase}`)
  console.error('Done.')
} catch (err) {
  console.error('ERROR:', err.message ?? err)
  process.exit(1)
}
