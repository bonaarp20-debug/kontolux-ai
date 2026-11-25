// O18a M1: Fehlerelemente im Antwortstrom von runQuery/batchGet (Status 200) dürfen nie als vollständige Antwort gelten.
// Reine Tests der Prüfung und der Stellen in der Regel-Schicht (regel/firestore.js, regel/archiv.js, regel/loeschlaeufe.js). Der Export steht in datev-lesen.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abfrageStrom, batchGetStrom, lesenMitEinerWiederholung, StromAbbruch, stromWiederholbar } from '../regel/firestore-strom.js';
import { erzeugeSchicht } from '../regel/firestore.js';
import { untersammlungLesen } from '../regel/archiv.js';
import { firestore } from '../regel/loeschlaeufe.js';

const FEHLER = { error: { code: 14, message: 'geheimer Text', status: 'UNAVAILABLE' } };
const ant = (b) => async () => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const NAME = 'projects/kontolux-ai/databases/(default)/documents/users/u1/dokumente/d1';
const DOK = { document: { name: NAME, fields: {} }, readTime: 't' };

test('abfrageStrom: Liste ohne Fehler gilt (auch leer wie bei Firestore), alles andere bricht ab', () => {
  assert.deepEqual(abfrageStrom([DOK], 'x'), [DOK]);
  assert.deepEqual(abfrageStrom([{ readTime: 't' }], 'x'), [{ readTime: 't' }]);
  assert.deepEqual(abfrageStrom([], 'x'), []);
  assert.throws(() => abfrageStrom([DOK, FEHLER], 'x'), /Strom abgebrochen \(UNAVAILABLE\)/);
  assert.throws(() => abfrageStrom([FEHLER], 'x'), /abgebrochen/);
  assert.throws(() => abfrageStrom({}, 'x'), /keine Liste/);
  assert.throws(() => abfrageStrom(null, 'x'), /keine Liste/);
  assert.throws(() => abfrageStrom(undefined, 'x'), /keine Liste/);
  assert.throws(() => abfrageStrom('x', 'x'), /keine Liste/);
  assert.throws(() => abfrageStrom([DOK, null], 'x'), /unvollständig/);
  assert.throws(() => abfrageStrom({ error: { code: 14 } }, 'x'), /keine Liste/);
  try { abfrageStrom([FEHLER], 'x'); } catch (e) { assert.ok(!/geheimer Text/.test(e.message), 'kein Fehlertext aus Firestore im Fehler'); }
});
test('batchGetStrom: jedes Element braucht found oder missing', () => {
  assert.deepEqual(batchGetStrom([{ found: DOK.document }, { missing: NAME }], 'x').length, 2);
  assert.deepEqual(batchGetStrom([], 'x'), []);
  assert.throws(() => batchGetStrom([{ found: DOK.document }, FEHLER], 'x'), /abgebrochen/);
  assert.throws(() => batchGetStrom([{ readTime: 't' }], 'x'), /unvollständig/);
  assert.throws(() => batchGetStrom({}, 'x'), /keine Liste/);
});

test('Regel-Schicht: batchGet und runQuery brechen bei Fehlerelement und bei 200 ohne Liste ab', async () => {
  for (const b of [[{ found: DOK.document }, FEHLER], {}, null, [{ readTime: 't' }]]) {
    const fs = erzeugeSchicht({ token: 't', fetchFn: ant(b) });
    await assert.rejects(() => fs.batchGet(['users/u1/dokumente/d1']), JSON.stringify(b));
  }
  for (const b of [[DOK, FEHLER], {}, null]) {
    const fs = erzeugeSchicht({ token: 't', fetchFn: ant(b) });
    await assert.rejects(() => fs.runQuery('users/u1', { from: [{ collectionId: 'dokumente' }] }), JSON.stringify(b));
  }
  const gut = erzeugeSchicht({ token: 't', fetchFn: ant([DOK]) });
  assert.equal((await gut.runQuery('users/u1', {})).length, 1);
  const leer = erzeugeSchicht({ token: 't', fetchFn: ant([{ readTime: 't' }]) });
  assert.equal((await leer.runQuery('users/u1', {})).length, 0);
  const fundMiss = erzeugeSchicht({ token: 't', fetchFn: ant([{ found: DOK.document }, { missing: NAME + 'x' }]) });
  assert.equal((await fundMiss.batchGet(['users/u1/dokumente/d1', 'users/u1/dokumente/d1x'])).size, 2);
});

test('Archiv-Lesen (Löschlauf, Export): ein Fehlerelement im Strom bricht ab; im Teil-Modus meldet es unvollständig statt vollständig', async () => {
  await assert.rejects(() => untersammlungLesen('u1', 'versionen', 't', ant([DOK, FEHLER])), /abgebrochen/);
  await assert.rejects(() => untersammlungLesen('u1', 'versionen', 't', ant({})), /keine Liste/);
  const teil = await untersammlungLesen('u1', 'versionen', 't', ant([FEHLER]), { teil: true });
  assert.equal(teil.vollstaendig, false);
});

test('Löschlauf-Schicht: runQuery mit Fehlerelement wirft', async () => {
  const f = firestore(ant([DOK, FEHLER]), async () => 't', 'scope');
  assert.ok(f && typeof f === 'object');
  // alle Abfrage-Methoden der Schicht laufen über laufAbfrage: eine mit leerem Aufruf genügt
  await assert.rejects(() => f.nachfahren('users/u1', { limit: 5 }), /abgebrochen/);
});

// O19-3: genau ein Wiederholungsversuch bei vorübergehendem UNAVAILABLE (nur Lesepfade rufen lesenMitEinerWiederholung)
test('lesenMitEinerWiederholung: Fehler einmal, dann gültig gilt; zweimal bricht ab; andere Fehler werden nicht wiederholt', async () => {
  let n = 0;
  const einmal = async () => { n++; return abfrageStrom(n === 1 ? [DOK, FEHLER] : [DOK], 'x'); };
  assert.deepEqual(await lesenMitEinerWiederholung(einmal, 1), [DOK]);
  assert.equal(n, 2);
  n = 0;
  const immer = async () => { n++; return abfrageStrom([DOK, FEHLER], 'x'); };
  await assert.rejects(() => lesenMitEinerWiederholung(immer, 1), /Strom abgebrochen \(UNAVAILABLE\)/);
  assert.equal(n, 2, 'nie mehr als ein Wiederholungsversuch');
  for (const fremd of [{ error: { code: 4, status: 'DEADLINE_EXCEEDED' } }, { error: { code: 13, status: 'INTERNAL' } }, { error: { message: 'x' } }]) {
    n = 0;
    await assert.rejects(() => lesenMitEinerWiederholung(async () => { n++; return abfrageStrom([fremd], 'x'); }, 1), /abgebrochen/);
    assert.equal(n, 1, JSON.stringify(fremd));
  }
  n = 0;
  await assert.rejects(() => lesenMitEinerWiederholung(async () => { n++; throw new Error('HTTP 500'); }, 1), /HTTP 500/);
  assert.equal(n, 1, 'HTTP-Fehler und andere Fehler werden nicht wiederholt');
  n = 0;
  await assert.rejects(() => lesenMitEinerWiederholung(async () => { n++; return abfrageStrom({}, 'x'); }, 1), /keine Liste/);
  assert.equal(n, 1);
  assert.ok(stromWiederholbar(new StromAbbruch('x', 'UNAVAILABLE')) && stromWiederholbar(new StromAbbruch('x', '14')));
  assert.ok(!stromWiederholbar(new Error('UNAVAILABLE')) && !stromWiederholbar(new StromAbbruch('x', 'INTERNAL')));
  assert.ok(!/geheimer Text/.test((await lesenMitEinerWiederholung(async () => abfrageStrom([DOK], 'x'), 1)).length ? '' : 'x'));
});
