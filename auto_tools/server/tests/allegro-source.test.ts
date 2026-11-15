import assert from 'node:assert/strict';
import test from 'node:test';
import { collectedProductSchema } from '../src/routes/schemas.js';

test('Allegro 采集结果可通过服务端来源校验', () => {
  const parsed = collectedProductSchema.parse({
    source: 'allegro',
    sourceUrl: 'https://allegro.pl/oferta/koszulka-z-nadrukiem-personalizowanym-logo-zdjecie-grafika-tekst-napis-l-17184804841',
    sourceProductId: '17184804841',
    title: 'Koszulka z nadrukiem personalizowanym Logo Zdjęcie Grafika Tekst Napis L',
    description: 'Koszulka z własnym nadrukiem.',
    images: ['https://a.allegroimg.com/original/example.jpg'],
    price: { value: 25.98, currency: 'PLN' },
    variants: [
      {
        sourceSkuId: '17184804841',
        options: { Color: 'czarny', Size: 'L' },
        price: 25.98,
      },
    ],
    attributes: { Marka: 'NewOne', Kolor: 'czarny', Rozmiar: 'L' },
    store: { name: 'fxstriker', url: 'https://allegro.pl/uzytkownik/fxstriker' },
  });

  assert.equal(parsed.source, 'allegro');
  assert.equal(parsed.variants[0].sourceSkuId, '17184804841');
  assert.equal(parsed.price?.currency, 'PLN');
});
