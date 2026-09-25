import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderIdFromUrl, folderUrl } from './gdrive.ts';

test('a record folder is found in any shape of Drive link the old repository stored', () => {
  assert.equal(folderIdFromUrl('https://drive.google.com/drive/folders/1NbSr1vaeD0sO4DLpW4oW6IUssEZGWz4K'), '1NbSr1vaeD0sO4DLpW4oW6IUssEZGWz4K');
  assert.equal(folderIdFromUrl('https://drive.google.com/drive/u/0/folders/1-9R7ugzu0Ba0W-axRaml70WzM7bASxdh?usp=sharing'), '1-9R7ugzu0Ba0W-axRaml70WzM7bASxdh');
  assert.equal(folderIdFromUrl('https://drive.google.com/open?id=1H0CFTRmDmh6XJ8yyaXH'), '1H0CFTRmDmh6XJ8yyaXH');
  assert.equal(folderIdFromUrl(''), null);
  assert.equal(folderIdFromUrl(null), null);
  assert.equal(folderUrl('abc123DEF456'), 'https://drive.google.com/drive/folders/abc123DEF456');
});
