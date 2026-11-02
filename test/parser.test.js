import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, cleanBody, parseTarget } from '../src/parser.js';
import { parseDue } from '../src/dates.js';

// Monday 2 Nov 2026, 10:00 local
const NOW = new Date(2026, 10, 2, 10, 0, 0);

test('creates a task from a bracketed email subject with inline tokens', () => {
  const r = parseMessage({ subject: '[WEB] Redesign homepage due:fri 3pm !high @pete +client', body: 'Use the new brand colours.' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.type, 'create');
  assert.equal(a.projectKey, 'WEB');
  assert.equal(a.title, 'Redesign homepage');
  assert.equal(a.fields.due, 'fri 3pm');
  assert.equal(a.fields.priority, 'high');
  assert.equal(a.fields.assignee, 'pete');
  assert.equal(a.fields.clientVisible, true);
  assert.equal(a.fields.description, 'Use the new brand colours.');
});

test('KEY: prefix works for text messages, body fields override', () => {
  const r = parseMessage({ text: 'AEF: Submit citations\npriority: urgent\nvisible: internal\nassign: Christine' });
  const a = r.actions[0];
  assert.equal(a.projectKey, 'AEF');
  assert.equal(a.title, 'Submit citations');
  assert.equal(a.fields.priority, 'urgent');
  assert.equal(a.fields.clientVisible, false);
  assert.equal(a.fields.assignee, 'Christine');
});

test('normal-case "Hi:" is not mistaken for a project key', () => {
  assert.equal(parseTarget('Hi: can you look at this').kind, 'none');
  assert.equal(parseTarget('[Web] thing').kind, 'project');
});

test('reply to a task email adds the body as a comment and ignores the echoed title', () => {
  const r = parseMessage({
    subject: 'Re: [WEB-12] Redesign homepage',
    body: 'Client approved the mockups.\n\nOn Mon, Nov 2, 2026 at 9:00 AM TaskBoard wrote:\n> old stuff',
  });
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.type, 'update');
  assert.equal(a.taskNumber, 12);
  assert.equal(a.projectKey, 'WEB');
  assert.equal(a.fields.comment, 'Client approved the mockups.');
  assert.equal(a.fields.title, undefined);
});

test('status shortcuts and multi-line batches', () => {
  const r = parseMessage({ text: 'WEB-12 done\n#14 due: next tuesday\nAEF-3 move to waiting on client\n[SPEC-9] note: call back after 3' });
  assert.equal(r.actions.length, 4);
  assert.deepEqual(r.actions[0].fields.status.done, true);
  assert.equal(r.actions[1].taskNumber, 14);
  assert.equal(r.actions[1].fields.due, 'next tuesday');
  assert.match(r.actions[2].fields.status.raw, /waiting on client/i);
  assert.equal(r.actions[3].fields.note, 'call back after 3');
});

test('message without a project is flagged untargeted', () => {
  const r = parseMessage({ text: 'Call the printer about business cards' });
  assert.equal(r.untargeted, true);
  assert.equal(r.actions[0].title, 'Call the printer about business cards');
  assert.equal(r.actions[0].projectKey, null);
});

test('cleanBody strips quotes and signatures', () => {
  assert.equal(cleanBody('Hello\n> quoted\n-- \nBernard\nCEO'), 'Hello');
  assert.equal(cleanBody('Done.\nSent from my iPhone'), 'Done.');
});

test('parseDue understands common phrases', () => {
  const d = (s) => parseDue(s, NOW)?.date;
  assert.equal(d('today').getHours(), 17);
  assert.equal(d('tomorrow 9am').getDate(), 3);
  assert.equal(d('tomorrow 9am').getHours(), 9);
  assert.equal(d('fri').getDate(), 6);
  assert.equal(d('friday 3pm').getHours(), 15);
  assert.equal(d('next monday').getDate(), 9);
  assert.equal(d('monday').getDate(), 2); // it's Monday 10:00, so today 17:00 is still ahead
  assert.equal(d('monday 9am').getDate(), 9); // already passed today -> next week
  assert.equal(d('nov 20').getMonth(), 10);
  assert.equal(d('jan 5').getFullYear(), 2027); // rolls forward
  assert.equal(d('11/25').getDate(), 25);
  assert.equal(d('2026-12-01').getMonth(), 11);
  assert.equal(d('2026-12-01T09:30').getMinutes(), 30);
  assert.equal(d('in 3 days').getDate(), 5);
  assert.equal(d('eow').getDay(), 5);
  assert.equal(parseDue('none', NOW).clear, true);
  assert.equal(parseDue('whenever you can', NOW), null);
});
