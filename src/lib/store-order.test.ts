import { test } from 'node:test';
import assert from 'node:assert/strict';
import { againstOrder, cartLinks, orderWarnings, packFor, parseOrderMd, readOrder, storeProduct, withProduct } from './store-order.ts';

// MarkDownload of walmart.com/orders/<n>, "Download selection" (owner, 2026-10-15) — the pickup person and card left out.
const WALMART = `## Oct 15, 2026 order

Order# 2000156-31789057

19 items shopped

[![](https://i5.walmartimages.com/seo/Equate-50-FO.jpeg?odnHeight=208&odnWidth=208)](https://www.walmart.com/ip/Equate-Aloe-Vera-Liquid-Hand-Soap-Refill-50-fl-oz/532880658)

[

Equate Aloe Vera Liquid Hand Soap with Moisturizers, 50 fl oz

](https://www.walmart.com/ip/Equate-Aloe-Vera-Liquid-Hand-Soap-Refill-50-fl-oz/532880658)

Multipack Quantity: 1

5.9¢/fl oz

Qty 2

$5.94

$2.97 ea

___

[![](https://i5.walmartimages.com/seo/Ajax.jpeg?odnHeight=208)](https://www.walmart.com/ip/Ajax-Super-Degreaser-Lemon-Dishwashing-Liquid-90-fl-oz/34938309)

[

Ajax Ultra Super Degreaser Dishwashing Liquid Dish Soap Refill, Lemon Scent, 90 fl oz

](https://www.walmart.com/ip/Ajax-Super-Degreaser-Lemon-Dishwashing-Liquid-90-fl-oz/34938309)

6.6¢/fl oz

Qty 1

$5.97

___

[![](https://i5.walmartimages.com/seo/ARM.jpeg)](https://www.walmart.com/ip/A-H-UNIT-DOSE-WITH-OXICLEAN-TRIPLE-CHAMBER-LIQUID-42CT/147545592)

[

ARM & HAMMER Plus OxiClean 5-in-1 Laundry Detergent Paks, Fresh Scent, 42 Count

](https://www.walmart.com/ip/A-H-UNIT-DOSE-WITH-OXICLEAN-TRIPLE-CHAMBER-LIQUID-42CT/147545592)

30.8¢/oz

Qty 1

$9.12

___

[![](https://i5.walmartimages.com/seo/Toilet-Paper.jpeg)](https://www.walmart.com/ip/Toilet-Paper-4-Rolls-150-2-Ply-Sheets-per-Roll/1275613286)

[

Toilet Paper, 4 Rolls, 150 2-Ply Sheets per Roll

](https://www.walmart.com/ip/Toilet-Paper-4-Rolls-150-2-Ply-Sheets-per-Roll/1275613286)

Multipack Quantity: 1

Qty 4

$3.76

$0.94 ea

___

[![](https://i5.walmartimages.com/seo/Paper-Towels.jpeg)](https://www.walmart.com/ip/Black-and-White-2-Ply-Paper-Towels-88-Sheets/287001150)

[

Black and White, 2-Ply Paper Towels, White, 88 Sheets

](https://www.walmart.com/ip/Black-and-White-2-Ply-Paper-Towels-88-Sheets/287001150)

Multipack Quantity: 1

Qty 10

$7.40

$0.74 ea

___

[![](https://i5.walmartimages.com/asr/3f743bff.jpeg)](https://www.walmart.com/ip/Great-Value-13-Gallon-Drawstring-Tall-Kitchen-Trash-Bags-Unscented-40-Bags/344638043)

[

Great Value Tall Kitchen Trash Bags, 13 gal, Drawstring, Unscented, 40 Bags

](https://www.walmart.com/ip/Great-Value-13-Gallon-Drawstring-Tall-Kitchen-Trash-Bags-Unscented-40-Bags/344638043)

Count Per Pack: 40

Qty 1

$6.48

___

## How can we help?

Curbside pickup

___

Subtotal (19 items)$38.67

___

Taxes

Taxes

$3.19

___

Total$41.86`;

// MarkDownload of an Amazon order's details (owner, 2026-10-15), shortened: the price is one's; "3" alone is the quantity.
const AMAZON = `Order placed

October 5, 2026

Order #

113-2518508-6894635

##### Order Summary

-   Item(s) Subtotal:

    $84.84

-   Shipping & Handling:

    $2.99


-   Promotion applied::

    \\-$7.60

-   Total before tax:

    $77.24

-   Estimated tax to be collected:

    $4.56


#### Delivered October 6

[![Bedsure Queen Comforter Set Prewashed Soft Bedding Set 3Pcs White 90"x90"](https://m.media-amazon.com/images/I/81dTpCrVC1L._SS284_.jpg)](https://www.amazon.com/dp/B0CGLPNL77?ref_=ppx_hzod_image_dt_b_fed_asin_title_0_0)

Return or replace items: Eligible through November 5, 2026

$37.99

[![Amazon Basics Gentle & Mild Clear Liquid Hand Soap Refill, 50 Fl Oz, 2-Pack](https://m.media-amazon.com/images/I/71TD1OkCLPL._SS284_.jpg)](https://www.amazon.com/dp/B09HHDGQKD?ref_=ppx_hzod_image_dt_b_fed_asin_title_0_1)

3

Sold by: Amazon

Return or replace items: Eligible through November 5, 2026

$5.66

#### Delivered October 6

[![Amazon Basics Basket Coffee Filters for 8-12 Cup Coffee Makers, White, 200 Count](https://m.media-amazon.com/images/I/713RNs-2P3L._SS284_.jpg)](https://www.amazon.com/dp/B0C4Z6SKCS?ref_=ppx_hzod_image_dt_b_fed_asin_title_1_0)

Sold by: Amazon.com

$1.89

[![Queen Size Mattress Protector Waterproof](https://m.media-amazon.com/images/I/71RUS4Pf24L._SS284_.jpg)](https://www.amazon.com/dp/B08BBZKSTS?ref_=ppx_hzod_image_dt_b_fed_asin_title_3_0)

2

Return or replace items: Eligible through November 5, 2026

$13.99`;

test('storeProduct: Walmart item ids and Amazon ASINs from their links', () => {
  assert.deepEqual(storeProduct('https://www.walmart.com/ip/Toilet-Paper-4-Rolls/1275613286?x=1'),
    { store: 'walmart', id: '1275613286', url: 'https://www.walmart.com/ip/Toilet-Paper-4-Rolls/1275613286' });
  assert.equal(storeProduct('https://www.walmart.com/ip/344638043')?.id, '344638043');
  assert.deepEqual(storeProduct('https://www.amazon.com/dp/B0C4Z6SKCS?ref_=ppx'), { store: 'amazon', id: 'B0C4Z6SKCS', url: 'https://www.amazon.com/dp/B0C4Z6SKCS' });
  assert.equal(storeProduct('https://www.amazon.com/Some-Name/dp/B005IHUYVA/ref=sr_1')?.id, 'B005IHUYVA');
  assert.equal(storeProduct('https://www.amazon.com/gp/product/B09HHDGQKD')?.id, 'B09HHDGQKD');
  assert.equal(storeProduct('https://www.costco.com/item.html'), null);
});

test('parseOrderMd: a Walmart order — 6 products, line prices as printed, 19 items, tax and total', () => {
  const o = parseOrderMd(WALMART);
  assert.equal(o.store, 'walmart');
  assert.equal(o.orderNo, '2000156-31789057');
  assert.equal(o.date, '2026-10-15');
  assert.deepEqual([o.subtotal, o.tax, o.total, o.count], [38.67, 3.19, 41.86, 19]);
  assert.deepEqual(o.lines.map(l => [l.product.id, l.qty, l.amount]),
    [['532880658', 2, 5.94], ['34938309', 1, 5.97], ['147545592', 1, 9.12], ['1275613286', 4, 3.76], ['287001150', 10, 7.4], ['344638043', 1, 6.48]]);
  assert.equal(o.lines.reduce((a, l) => a + l.qty, 0), 19);
  assert.equal(o.lines[0]!.text, 'Equate Aloe Vera Liquid Hand Soap with Moisturizers, 50 fl oz');
  assert.equal(o.lines[3]!.unitPrice, 0.94);
  // "4 Rolls", never "150 … Sheets per Roll"; "Count Per Pack: 40"; "42 Count".
  assert.deepEqual([o.lines[3]!.pack, o.lines[3]!.packWord], [4, 'rolls']);
  assert.deepEqual([o.lines[5]!.pack, o.lines[2]!.pack], [40, 42]);
});

test('parseOrderMd: an Amazon order — the price is one\'s, the lone number the quantity; total = before tax + tax', () => {
  const o = parseOrderMd(AMAZON);
  assert.equal(o.store, 'amazon');
  assert.equal(o.orderNo, '113-2518508-6894635');
  assert.equal(o.date, '2026-10-05');
  assert.deepEqual(o.lines.map(l => [l.product.id, l.qty, l.unitPrice, l.amount]),
    [['B0CGLPNL77', 1, 37.99, 37.99], ['B09HHDGQKD', 3, 5.66, 16.98], ['B0C4Z6SKCS', 1, 1.89, 1.89], ['B08BBZKSTS', 2, 13.99, 27.98]]);
  assert.equal(o.lines[1]!.text, 'Amazon Basics Gentle & Mild Clear Liquid Hand Soap Refill, 50 Fl Oz, 2-Pack');
  assert.deepEqual([o.subtotal, o.tax, o.total], [84.84, 4.56, 81.8]);
});

const items = [
  { id: '1', name: 'Toilet paper', measure: 'roll', buyOptions: [{ label: 'Walmart', url: 'https://www.walmart.com/ip/x/1275613286', pack: 4 }] },
  { id: '2', name: 'Trash bags 13 gal', measure: 'bag' },
  { id: '3', name: 'Hand soap refill', measure: 'bottle' },
  { id: '4', name: 'Paper towels', measure: 'roll' },
  { id: '5', name: 'Dish soap', measure: 'bottle', buyOptions: [{ label: 'Walmart', url: 'https://www.walmart.com/ip/34938309' }] },
];

test('readOrder: sure only by the product number or a decided text; look-alikes to confirm; fees so it adds up', () => {
  const r = readOrder(parseOrderMd(WALMART), items, [], new Map([['black and white, 2-ply paper towels, white, 88 sheets', '4']]));
  const by = (id: string) => r.lines.find(l => l.product?.id === id)!;
  assert.deepEqual([by('1275613286').itemId, by('1275613286').match, by('1275613286').itemQty], ['1', 'product', 16]); // 4 packs × 4 rolls remembered
  assert.deepEqual([by('34938309').itemId, by('34938309').match], ['5', 'product']);
  assert.deepEqual([by('287001150').itemId, by('287001150').match, by('287001150').itemQty], ['4', 'alias', 10]);
  assert.equal(by('344638043').itemId, null);
  assert.equal(by('344638043').match, 'guess');
  assert.equal(by('344638043').candidates[0], '2');
  assert.equal(by('147545592').match, 'none'); // laundry pods: nothing like it
  assert.equal(r.store, 'Walmart');
  assert.equal(r.lines.some(l => l.kind !== 'item'), false); // 38.67 + 3.19 = 41.86: nothing left over
  const a = readOrder(parseOrderMd(AMAZON), items);
  assert.deepEqual(a.lines.at(-1), { text: 'Savings and promotions', qty: null, unitPrice: null, amount: -7.6, kind: 'discount', itemId: null, itemQty: null,
                                     candidates: [], orderId: null, size: null, newName: null });
});

test('packFor: the remembered pack, else the printed one when it counts the supply\'s measure', () => {
  assert.equal(packFor({ pack: 40, packWord: 'count' }, 'bag'), 40);
  assert.equal(packFor({ pack: 4, packWord: 'rolls' }, 'roll'), 4);
  assert.equal(packFor({ pack: 4, packWord: 'rolls' }, 'pack'), 1);
  assert.equal(packFor({ pack: 88, packWord: 'sheets' }, 'roll'), 1);
  assert.equal(packFor({ pack: null, packWord: null }, 'roll', 6), 6);
});

test('withProduct: plan A is the bought product; the one it replaces stays as plan B; other links stay', () => {
  const opts = [{ label: 'Costco', url: 'https://www.costco.com/x' }, { label: 'WM tall', url: 'https://www.walmart.com/ip/344638043', pack: 40 }];
  assert.deepEqual(withProduct(opts, 'https://www.walmart.com/ip/Great-Value/344638043', null),
    [{ label: 'WM tall', url: 'https://www.walmart.com/ip/344638043', pack: 40 }, opts[0]]);
  const ab = withProduct(opts, 'https://www.amazon.com/dp/B0C4Z6SKCS?ref=x', 50);
  assert.deepEqual(ab, [{ label: 'Amazon', url: 'https://www.amazon.com/dp/B0C4Z6SKCS', pack: 50 }, opts[1], opts[0]]);
  // Plan B bought: it becomes plan A, and plan A its plan B — never three.
  assert.deepEqual(withProduct(ab, 'https://www.walmart.com/ip/344638043', null), [opts[1], ab[0], opts[0]]);
  assert.deepEqual(withProduct(ab, 'https://www.walmart.com/ip/50015132', 1).map(o => o.url), ['https://www.walmart.com/ip/50015132', ab[0]!.url, opts[0]!.url]);
  assert.equal(withProduct(opts, 'https://example.com', 2), opts);
});

test('orderWarnings: no order number or date (a selection started below the title); products short of the subtotal', () => {
  assert.deepEqual(orderWarnings(parseOrderMd(WALMART)), []);
  const cut = parseOrderMd(WALMART.slice(WALMART.indexOf('19 items shopped')));
  assert.match(orderWarnings(cut)[0]!, /^No order number or date in the file — select from the order's title/);
  const short = parseOrderMd(WALMART.replace(/\[!\[\]\(https:\/\/i5\.walmartimages\.com\/seo\/Ajax[\s\S]*?___/, ''));
  assert.match(orderWarnings(short)[0]!, /add up to \$32\.70, the subtotal says \$38\.67/);
  assert.deepEqual(orderWarnings(parseOrderMd(AMAZON)), []);
});

test('cartLinks: Walmart\'s cart, packs rounded up; Amazon supplies as their product pages; the rest named', () => {
  const its = [...items, { id: '6', name: 'Coffee filters', measure: 'filter', buyOptions: [{ label: 'Amazon', url: 'https://www.amazon.com/dp/B0C4Z6SKCS', pack: 200 }] }];
  const c = cartLinks([{ itemId: '1', qty: 10 }, { itemId: '5', qty: 2 }, { itemId: '6', qty: 150 }, { itemId: '2', qty: 3 }, { itemId: '4', qty: 0 }], its);
  assert.equal(c.walmart.url, 'https://affil.walmart.com/cart/addToCart?items=1275613286|3,34938309|2');
  assert.deepEqual(c.amazon, [{ url: 'https://www.amazon.com/dp/B0C4Z6SKCS', qty: 1, itemId: '6' }]);
  assert.deepEqual(c.none, ['2']);
  assert.equal(cartLinks([{ itemId: '2', qty: 1 }], its).walmart.url, null);
});

test('againstOrder: missing, fewer, more, not ordered', () => {
  const r = againstOrder(new Map([['1', 8], ['2', 40], ['3', 2], ['4', 6]]), new Map([['1', 8], ['2', 20], ['4', 10], ['5', 1]]));
  assert.deepEqual(r, { ok: ['1'], missing: ['3'], fewer: ['2'], more: ['4'], extra: ['5'] });
});

// A store purchase (Sep 12, 2026, shortened): each scan its own block; the TC# stands for the order number.
const towel = (qty: number, price: string) => `[![](https://i5.walmartimages.com/seo/Towel.jpeg)](https://www.walmart.com/ip/Mainstays-Bath-Towel/1914075718)

[

Mainstays Performance Cotton Bath Towel, White

](https://www.walmart.com/ip/Mainstays-Bath-Towel/1914075718)

Shopped

Qty ${qty}

$${price}

Add to cart

___
`;
const STORE = `# Sep 12, 2026 purchase

TC# 9885-6598-6559-6636-4188-2

Store purchase

## Sep 12, 2026 purchase

___

4 items

${towel(1, '3.97')}${towel(1, '3.97')}${towel(2, '7.94')}
## How can we help?

Subtotal (4 items)$15.88

Taxes

$1.31

Total$17.19`;

test('parseOrderMd: a Walmart store purchase — repeated scans added up, TC# and the purchase date', () => {
  const o = parseOrderMd(STORE);
  assert.equal(o.orderNo, '9885-6598-6559-6636-4188-2');
  assert.equal(o.date, '2026-09-12');
  assert.equal(o.lines.length, 1);
  assert.deepEqual([o.lines[0]!.qty, o.lines[0]!.amount, o.lines[0]!.unitPrice], [4, 15.88, 3.97]);
  assert.deepEqual(orderWarnings(o), []);
});

test('parseOrderMd: an online order — list price, savings and old price skipped; returned and unavailable left out; multipacks', () => {
  const o = parseOrderMd(`# Oct 05, 2026 order

Order# 2000153-26443647

[![](https://i5.walmartimages.com/seo/Folgers.jpeg)](https://www.walmart.com/ip/Folgers-Classic-Roast/578550306)

[

Folgers Classic Roast Ground Coffee, 25.9 oz Canister

](https://www.walmart.com/ip/Folgers-Classic-Roast/578550306)

$14.96/ea

Qty 1

$2.00 from savings

$12.96

Was $14.96

$14.96

___

[![](https://i5.walmartimages.com/seo/Mug.jpeg)](https://www.walmart.com/ip/Mainstays-Mug/211142390)

[

(6 pack) Mainstays 12 oz White Glazed Stoneware Mug

](https://www.walmart.com/ip/Mainstays-Mug/211142390)

Multipack Quantity: 6

$1.48/ea

Qty 2

$12.00

$1.00 ea

___

Return to Walmart store

Return details

[![](https://i5.walmartimages.com/seo/Throw.jpeg)](https://www.walmart.com/ip/Mainstays-Fleece-Throw/19427424239)

[

Mainstays Cozy Fleece Throw Blanket

](https://www.walmart.com/ip/Mainstays-Fleece-Throw/19427424239)

Qty 3

$11.91

10 unavailable items

[![](https://i5.walmartimages.com/seo/Folgers.jpeg)](https://www.walmart.com/ip/Folgers-Classic-Roast/578550306)

Qty 4

$59.84

## How can we help?

Taxes

$2.06

Total$27.02`);
  assert.deepEqual(o.lines.map(l => [l.product.id, l.qty, l.amount, l.unitPrice, l.pack]),
    [['578550306', 1, 12.96, 12.96, null], ['211142390', 2, 12, 6, 6]]);
});

test('readOrder: a set — one product on several supplies — split into each, its pieces counted, the price shared', () => {
  const swirl = 'https://www.walmart.com/ip/MS-49-SWIRL-FLATWARE/17074320417';
  const set = [
    { id: '32', name: 'Forks', measure: 'fork', buyOptions: [{ label: 'Walmart', url: swirl, pack: 16 }] },
    { id: '33', name: 'Knives', measure: 'knife', buyOptions: [{ label: 'Walmart', url: swirl, pack: 8 }] },
    { id: '34', name: 'Spoons', measure: 'spoon', buyOptions: [{ label: 'Walmart', url: swirl, pack: 24 }] },
  ];
  const o = parseOrderMd(STORE.replaceAll('Mainstays-Bath-Towel/1914075718', 'MS-49-SWIRL-FLATWARE/17074320417'));
  const r = readOrder(o, set);
  assert.deepEqual(r.lines.map(l => [l.itemId, l.itemQty, l.amount, l.match]),
    [['32', 64, 5.3, 'product'], ['33', 32, 5.29, 'product'], ['34', 96, 5.29, 'product']]);
  assert.equal(Math.round(r.lines.reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100, 15.88);
  // The cart buys the set as often as the supply that needs most asks — not once per supply.
  const c = cartLinks([{ itemId: '32', qty: 10 }, { itemId: '33', qty: 9 }, { itemId: '34', qty: 5 }], set);
  assert.deepEqual(c.walmart.items.map(x => [x.id, x.qty]), [['17074320417', 2]]);
});
