#!/usr/bin/env node
// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
// Generates the synthetic Superstore 360 base data (data/orders.csv, people.csv, returns.csv).
// Every customer, product, brand and manager is invented; the output is fully determined by the seed.
//   node scripts/generate-data.mjs [seed]     (default seed 360)
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED = Number(process.argv[2] ?? 360)
const ORDER_LINES = 10_000
const ORDERS = 4_593
const RETURNED_ORDERS = 284
const CUSTOMERS = 795

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED)
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const pick = (a) => a[Math.floor(rnd() * a.length)]
const wpick = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let r = rnd() * total
  for (const [v, w] of pairs) if ((r -= w) < 0) return v
  return pairs.at(-1)[0]
}
const money = (n) => n.toFixed(4)

// country -> [region, weight, states[{name, cities[]}]]
const GEO = {
  'United Kingdom': ['North', 33, [
    { s: 'England', c: ['Leeds', 'Manchester', 'Bristol', 'Sheffield', 'Nottingham'] },
    { s: 'Scotland', c: ['Glasgow', 'Edinburgh'] },
    { s: 'Wales', c: ['Cardiff', 'Swansea'] },
  ]],
  Ireland: ['North', 2, [{ s: 'Leinster', c: ['Dublin', 'Kilkenny'] }, { s: 'Munster', c: ['Cork', 'Limerick'] }]],
  Sweden: ['North', 4, [{ s: 'Stockholm County', c: ['Stockholm'] }, { s: 'Västra Götaland', c: ['Gothenburg'] }]],
  Finland: ['North', 1, [{ s: 'Uusimaa', c: ['Helsinki', 'Espoo'] }]],
  Denmark: ['North', 1, [{ s: 'Capital Region', c: ['Copenhagen'] }, { s: 'Central Denmark', c: ['Aarhus'] }]],
  Norway: ['North', 1, [{ s: 'Oslo', c: ['Oslo'] }, { s: 'Vestland', c: ['Bergen'] }]],
  France: ['Central', 28, [
    { s: 'Île-de-France', c: ['Paris', 'Versailles'] },
    { s: 'Auvergne-Rhône-Alpes', c: ['Lyon', 'Grenoble'] },
    { s: 'Occitanie', c: ['Toulouse', 'Montpellier'] },
    { s: 'Pays de la Loire', c: ['Nantes'] },
  ]],
  Germany: ['Central', 21, [
    { s: 'Bavaria', c: ['Munich', 'Nuremberg'] },
    { s: 'North Rhine-Westphalia', c: ['Cologne', 'Düsseldorf'] },
    { s: 'Berlin', c: ['Berlin'] },
    { s: 'Hesse', c: ['Frankfurt'] },
  ]],
  Netherlands: ['Central', 4, [{ s: 'North Holland', c: ['Amsterdam'] }, { s: 'South Holland', c: ['Rotterdam', 'The Hague'] }]],
  Belgium: ['Central', 2, [{ s: 'Brussels', c: ['Brussels'] }, { s: 'Flanders', c: ['Antwerp', 'Ghent'] }]],
  Austria: ['Central', 3, [{ s: 'Vienna', c: ['Vienna'] }, { s: 'Styria', c: ['Graz'] }]],
  Switzerland: ['Central', 1, [{ s: 'Zurich', c: ['Zurich'] }, { s: 'Geneva', c: ['Geneva'] }]],
  Italy: ['South', 11, [
    { s: 'Lombardy', c: ['Milan', 'Bergamo'] },
    { s: 'Lazio', c: ['Rome'] },
    { s: 'Piedmont', c: ['Turin'] },
    { s: 'Campania', c: ['Naples'] },
  ]],
  Spain: ['South', 9, [
    { s: 'Community of Madrid', c: ['Madrid'] },
    { s: 'Catalonia', c: ['Barcelona', 'Girona'] },
    { s: 'Andalusia', c: ['Seville', 'Málaga'] },
    { s: 'Valencian Community', c: ['Valencia'] },
  ]],
  Portugal: ['South', 1, [{ s: 'Lisbon', c: ['Lisbon'] }, { s: 'Porto', c: ['Porto'] }]],
}
const COUNTRY_WEIGHTS = Object.entries(GEO).map(([k, v]) => [k, v[1]])

// category -> sub-category -> [code, unit price lo, hi, base margin, weight, nouns[]]
const CATALOG = {
  'Office Supplies': {
    Storage: ['ST', 8, 140, 0.16, 13, ['Storage Box', 'File Cabinet', 'Desk Organiser', 'Shelving Unit']],
    Labels: ['LA', 3, 25, 0.38, 5, ['Label Pack', 'Shipping Labels', 'Address Labels']],
    Appliances: ['AP', 25, 450, 0.17, 3, ['Desk Fan', 'Shredder', 'Kettle', 'Air Purifier']],
    Fasteners: ['FA', 2, 18, 0.30, 4, ['Staples', 'Paper Clips', 'Bulldog Clips', 'Drawing Pins']],
    Art: ['AR', 3, 60, 0.26, 14, ['Marker Set', 'Highlighters', 'Pencil Pack', 'Colour Pens']],
    Binders: ['BI', 4, 95, 0.12, 13, ['Ring Binder', 'Lever Arch File', 'Presentation Binder']],
    Paper: ['PA', 5, 70, 0.34, 5, ['Copy Paper', 'Notepads', 'Recycled Paper', 'Index Cards']],
    Supplies: ['SU', 4, 90, 0.10, 4, ['Scissors', 'Tape Dispenser', 'Stapler', 'Letter Opener']],
    Envelopes: ['EN', 4, 40, 0.37, 4, ['Padded Envelopes', 'Window Envelopes', 'Document Wallets']],
  },
  Technology: {
    Accessories: ['AC', 8, 220, 0.27, 5, ['USB Hub', 'Wireless Mouse', 'Keyboard', 'Webcam', 'Memory Stick']],
    Phones: ['PH', 60, 1100, 0.19, 6, ['Handset', 'Conference Phone', 'Headset', 'Desk Phone']],
    Copiers: ['CO', 250, 3200, 0.36, 4, ['Copier', 'Colour Copier', 'Document Scanner']],
    Machines: ['MA', 90, 2400, 0.08, 4, ['Label Printer', 'Fax Machine', 'Laminator', 'Binding Machine']],
  },
  Furniture: {
    Bookcases: ['BO', 60, 900, 0.07, 5, ['Bookcase', 'Display Shelf', 'Corner Unit']],
    Tables: ['TA', 120, 1500, -0.03, 1, ['Meeting Table', 'Folding Table', 'Standing Desk']],
    Chairs: ['CH', 70, 1100, 0.14, 5, ['Task Chair', 'Visitor Chair', 'Ergonomic Chair']],
    Furnishings: ['FU', 6, 220, 0.30, 5, ['Desk Lamp', 'Picture Frame', 'Wall Clock', 'Floor Mat']],
  },
}
const BRANDS = ['Norvale', 'Brightmoor', 'Kestrel & Vane', 'Aldermoor', 'Pennine', 'Corvid', 'Halcyon Works', 'Tessellate',
  'Ostrava', 'Marlowe', 'Fenwick', 'Lumen & Co', 'Quillon', 'Basalt', 'Harrowgate', 'Sundial', 'Thornfield', 'Wexcombe']
const VARIANTS = ['Black', 'Blue', 'Grey', 'White', 'Green', 'Red', 'Oak', 'Silver', 'Large', 'Compact', 'Twin Pack', 'Premium']

const FIRST = ['Alma', 'Bram', 'Calla', 'Dario', 'Elsie', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kiara', 'Leon', 'Mira', 'Nils',
  'Orla', 'Pavel', 'Quinn', 'Rosa', 'Soren', 'Thea', 'Ugo', 'Vera', 'Wim', 'Xenia', 'Yusuf', 'Zora', 'Anika', 'Bruno', 'Cleo', 'Dmitri']
const LAST = ['Ashby', 'Bellweather', 'Castellan', 'Dunmore', 'Eskelund', 'Fairbourne', 'Grimaldi', 'Hollis', 'Ivarsson', 'Jessop', 'Kovacs',
  'Lindgren', 'Marchetti', 'Novak', 'Oakhurst', 'Petrakis', 'Rennick', 'Satterthwaite', 'Thorne', 'Varga', 'Whitlock', 'Yarrow', 'Zielinski', 'Brandt']

// ---- products
const products = []
for (const [category, subs] of Object.entries(CATALOG)) {
  const catCode = category === 'Office Supplies' ? 'OFF' : category === 'Technology' ? 'TEC' : 'FUR'
  for (const [sub, [code, lo, hi, margin, w, nouns]] of Object.entries(subs)) {
    const n = Math.max(20, Math.round(w * 22))
    for (let i = 0; i < n; i++) {
      const brand = pick(BRANDS)
      const price = Math.round((lo + (hi - lo) * rnd() ** 2) * 100) / 100
      products.push({
        category, sub, margin, weight: w, price,
        id: `${catCode}-${code}-${String(10000000 + products.length * 7 + int(0, 6)).padStart(8, '0')}`,
        name: `${brand} ${pick(nouns)}, ${pick(VARIANTS)}`,
      })
    }
  }
}
const subWeights = Object.entries(CATALOG).flatMap(([, subs]) => Object.entries(subs).map(([s, v]) => [s, v[4]]))
const bySub = Object.fromEntries(subWeights.map(([s]) => [s, products.filter((p) => p.sub === s)]))

// ---- customers
const SEGMENTS = [['Consumer', 52], ['Corporate', 31], ['Home Office', 17]]
const customers = []
const usedIds = new Set()
while (customers.length < CUSTOMERS) {
  const f = pick(FIRST), l = pick(LAST)
  let id
  do { id = `${f[0]}${l[0]}-${int(10000, 99999)}` } while (usedIds.has(id))
  usedIds.add(id)
  customers.push({ id, name: `${f} ${l}`, segment: wpick(SEGMENTS), home: wpick(COUNTRY_WEIGHTS) })
}

// ---- orders
const DELIVERY = [['Standard Class', 60], ['Second Class', 20], ['First Class', 14.5], ['Same Day', 5.5]]
const LAG = { 'Standard Class': [4, 6], 'Second Class': [2, 4], 'First Class': [1, 3], 'Same Day': [0, 0] }
const DISCOUNT_BY_CAT = {
  'Office Supplies': [[0, 62], [0.1, 6], [0.15, 3], [0.2, 2], [0.3, 1], [0.4, 3], [0.5, 15], [0.6, 2], [0.7, 1]],
  Technology: [[0, 68], [0.1, 10], [0.15, 6], [0.2, 4], [0.3, 3], [0.4, 4], [0.5, 4], [0.8, 1]],
  Furniture: [[0, 55], [0.1, 6], [0.15, 6], [0.2, 8], [0.3, 6], [0.4, 8], [0.45, 2], [0.5, 6], [0.65, 2], [0.85, 1]],
}
const startMs = Date.UTC(2020, 0, 1)
const endMs = Date.UTC(2023, 11, 31)
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

const lineCounts = Array.from({ length: ORDERS }, () => wpick([[1, 38], [2, 27], [3, 17], [4, 10], [5, 5], [6, 3]]))
let total = lineCounts.reduce((a, b) => a + b, 0)
while (total !== ORDER_LINES) {
  const i = int(0, ORDERS - 1)
  if (total < ORDER_LINES && lineCounts[i] < 7) { lineCounts[i]++; total++ }
  else if (total > ORDER_LINES && lineCounts[i] > 1) { lineCounts[i]--; total-- }
}

const rows = []
const orderIds = new Set()
for (let o = 0; o < ORDERS; o++) {
  // later years carry more volume
  const day = Math.floor((endMs - startMs) / 86400000 * Math.sqrt(rnd()))
  const orderMs = startMs + day * 86400000
  let oid
  do { oid = `SS-${iso(orderMs).slice(0, 4)}-${int(1000000, 9999999)}` } while (orderIds.has(oid))
  orderIds.add(oid)
  const cust = pick(customers)
  const country = rnd() < 0.8 ? cust.home : wpick(COUNTRY_WEIGHTS)
  const [region, , states] = GEO[country]
  const st = pick(states)
  const city = pick(st.c)
  const mode = wpick(DELIVERY)
  const [lagLo, lagHi] = LAG[mode]
  const dispatch = iso(orderMs + int(lagLo, lagHi) * 86400000)
  for (let l = 0; l < lineCounts[o]; l++) {
    const p = pick(bySub[wpick(subWeights)])
    const qty = wpick([[1, 15], [2, 25], [3, 22], [4, 14], [5, 10], [6, 6], [7, 4], [8, 2], [9, 1], [10, 1]])
    const disc = wpick(DISCOUNT_BY_CAT[p.category])
    const sales = p.price * qty * (1 - disc)
    const marginRate = p.margin - disc * 0.9 + (rnd() - 0.5) * 0.08
    rows.push({
      oid, date: iso(orderMs), dispatch, mode, cust, segment: cust.segment, city, state: st.s, country, region, p, sales, qty, disc,
      profit: sales * marginRate,
    })
  }
}
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0))

const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const header = 'ROW_ID,ORDER_ID,ORDER_DATE,DISPATCH_DATE,DELIVERY_MODE,CUSTOMER_ID,CUSTOMER_NAME,SEGMENT,CITY,STATE_PROVINCE,COUNTRY_REGION,REGION,PRODUCT_ID,CATEGORY,SUB_CATEGORY,PRODUCT_NAME,SALES,QUANTITY,DISCOUNT,PROFIT'
const ordersCsv = [header, ...rows.map((r, i) => [
  i + 1, r.oid, r.date, r.dispatch, r.mode, r.cust.id, q(r.cust.name), r.segment, q(r.city), q(r.state), r.country, r.region,
  r.p.id, r.p.category, r.p.sub, q(r.p.name), money(r.sales), r.qty, money(r.disc), money(r.profit),
].join(','))].join('\n') + '\n'

// ---- returns: returned orders skew towards discounted / loss-making orders
const byOrder = new Map()
for (const r of rows) {
  const e = byOrder.get(r.oid) ?? { oid: r.oid, score: 1 }
  if (r.disc >= 0.4) e.score += 1.5
  if (r.profit < 0) e.score += 1
  byOrder.set(r.oid, e)
}
const pool = [...byOrder.values()]
const returned = []
while (returned.length < RETURNED_ORDERS) {
  const i = wpick(pool.map((e, idx) => [idx, e.score]))
  returned.push(pool[i].oid)
  pool.splice(i, 1)
}
returned.sort()
const returnsCsv = ['ORDER_ID,IS_RETURNED', ...returned.map((id) => `${id},True`)].join('\n') + '\n'

// ---- people: one named manager and one mailbox per region, as 04_semantic_view.sql expects
const peopleCsv = `PERSON_NAME,REGION
Lucia Montefiore,South
Tomas Verhoeven,Central
Elin Hartwell,North
central.manager@superstore.example,Central
north.manager@superstore.example,North
south.manager@superstore.example,South
`

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'orders.csv'), ordersCsv)
writeFileSync(join(dir, 'returns.csv'), returnsCsv)
writeFileSync(join(dir, 'people.csv'), peopleCsv)

const lineItemsReturned = rows.filter((r) => returned.includes(r.oid)).length
console.log(`seed=${SEED} lines=${rows.length} orders=${orderIds.size} customers=${new Set(rows.map((r) => r.cust.id)).size} ` +
  `returned_orders=${returned.length} returned_lines=${lineItemsReturned} products=${new Set(rows.map((r) => r.p.id)).size}`)
