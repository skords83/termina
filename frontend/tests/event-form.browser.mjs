// Run against `npm run dev`. Install Playwright separately; no app dependency.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/event-form.browser.mjs
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args:['--no-sandbox']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
let payload;
await page.route('**/api/events**', route => { payload = route.request().postDataJSON(); return route.fulfill({json:{uid:'test'}}); });
const open = async (query='') => { await page.goto(`http://127.0.0.1:5173/tests/event-form.html${query}`); await page.getByRole('heading').waitFor(); };
const save = async () => { await page.getByRole('button',{name:'Speichern', exact:true}).click(); await page.waitForFunction(() => window.saved); return payload; };
const visibleActions = async () => {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Speichern');
    const box = button?.getBoundingClientRect();
    return box && box.top >= 0 && box.bottom <= innerHeight;
  });
  const box = await page.getByRole('button',{name:'Speichern',exact:true}).boundingBox();
  assert(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
};
for (const viewport of [{width:1280,height:800},{width:375,height:667},{width:320,height:568}]) {
  await page.setViewportSize(viewport);
  for (const [name,title,time,end] of [['Samu','Judo','17:30','18:30'],['Sophine','U9','09:30','10:30']]) {
    await open();
    assert.equal(await page.locator('#event-summary').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('details').evaluate(el=>el.open), false);
    assert.equal(await page.getByRole('button',{name:'Nur Lesen',exact:true}).count(),0);
    await page.getByRole('button',{name,exact:true}).click();
    await page.locator('#event-summary').fill(title);
    await page.locator('input[type=time]').fill(time);
    assert.equal(await page.locator('.event-form-body').evaluate(el=>el.scrollHeight <= el.clientHeight + 1),true);
    await visibleActions();
    const timeBox = await page.locator('input[type=time]').boundingBox();
    const formBox = await page.locator('.event-form-body').boundingBox();
    assert(timeBox.x + timeBox.width <= formBox.x + formBox.width);
    if (title === 'U9') await page.screenshot({path:`/tmp/termina-${viewport.width}.png`});
    const result = await save();
    assert.equal(result.start,`2026-12-14T${time}:00`);
    assert.equal(result.end,`2026-12-14T${end}:00`);
    assert.equal(result.rrule,null); assert.deepEqual(result.reminders,[]);
  }
}
await open('?defaults');
await page.locator('#event-summary').fill('Vorgaben');
assert.match(await page.locator('summary').innerText(),/15 Min/);
await page.locator('input[type=time]').fill('23:30');
assert.equal((await save()).end,'2026-12-15T01:00:00');
await open();
await page.getByRole('button',{name:'Weiterer Kalender',exact:true}).click();
await page.locator('#event-summary').fill('Dauer');
await page.locator('#event-duration').fill('45');
await page.locator('input[type=time]').fill('08:00');
assert.equal((await save()).end,'2026-12-14T08:45:00');
assert.equal(payload.calendar_id,'3');
await open();
await page.locator('#event-summary').fill('Ganztag');
await page.getByText('Ganztägig',{exact:true}).click();
assert.equal((await save()).end,'2026-12-15'); assert.equal(payload.all_day,true);
for (const query of ['?edit&defaults','?edit&allDay']) {
  await open(query);
  await page.getByRole('button',{name:'Alle Termine der Serie',exact:false}).click();
  assert.match(await page.locator('summary').innerText(),/Wiederholung.*Ort.*Erinnerung.*Beschreibung/);
  await page.locator('#event-summary').fill('Geändert');
  const result = await save();
  assert.equal(result.location,'  Halle  '); assert.equal(result.description,'Notizen\n');
  assert.deepEqual(result.reminders,[5,30]);
  assert.equal(result.rrule,'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271214T090000Z');
  assert.equal(result.end,query.includes('allDay')?'2026-12-17':'2026-12-14T11:45:00');
}
await open();
await page.locator('summary').click();
await page.locator('#event-recur-freq').selectOption('WEEKLY');
await page.locator('#event-summary').fill('Serie');
assert.match((await save()).rrule,/FREQ=WEEKLY/);
await open();
await page.locator('summary').click();
await page.locator('#event-description').fill('Zusatz');
await visibleActions();
await page.screenshot({path:'/tmp/termina-options.png'});
await page.setViewportSize({width:375,height:360});
await visibleActions();
await page.screenshot({path:'/tmp/termina-short.png'});
await page.locator('#event-summary').fill('Tastatur');
await page.getByRole('button',{name:'Speichern',exact:true}).focus();
await page.keyboard.press('Tab');
assert.equal(await page.getByRole('button',{name:'Schließen',exact:true}).evaluate(el=>el===document.activeElement),true);
// Verify the actual month-cell → App → form handoff, beyond the fixture.
await page.setViewportSize({width:1280,height:800});
await page.clock.install({time: new Date('2026-12-01T12:00:00')});
await page.route('http://127.0.0.1:5173/api/**', route => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== 'GET') { payload = route.request().postDataJSON(); return route.fulfill({json:{uid:'app-test'}}); }
  const data = path === '/api/auth/me' ? {id:1,email:'test@example.invalid',display_name:'Test',role:'user',must_change_password:false}
    : path === '/api/calendars' ? [{id:'samu',name:'Samu',color:'#ed6262',can_write:true}]
    : path === '/api/events' ? [] : {};
  return route.fulfill({json:data});
});
await page.goto('http://127.0.0.1:5173/');

await page.locator('.day-cell:not(.day-cell--other)').filter({has:page.locator('.day-number', {hasText:/^14$/})}).getByTitle('Termin erstellen').click();
await page.locator('#event-summary').fill('Judo');
await page.locator('input[type=time]').fill('17:30');
await page.getByRole('button',{name:'Speichern',exact:true}).click();
await page.getByRole('dialog').waitFor({state:'hidden'});
assert.equal(payload.start,'2026-12-14T17:30:00');
assert.equal(payload.end,'2026-12-14T18:30:00');
assert.deepEqual(errors,[]);
await browser.close();
console.log('Browser checks passed: examples, responsive layout, defaults, duration, all-day, calendars, recurrence, hidden edit values, focus, short viewport.');
