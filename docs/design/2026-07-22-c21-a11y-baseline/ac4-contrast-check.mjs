// C21 AC4 (#478) contrast evidence — proves the LANDED tokens.css values pass WCAG AA on
// every adjacent-background pairing. Run: `node ac4-contrast-check.mjs` (exits 1 on any FAIL).
// This file is the one-off evidence trail and carries a COPY of the token values, so it can
// drift from the source. The live gate is packages/ui-mac/src/renderer/alpha-ui/
// contrast-ratchet.test.ts (#221): same math, but every value is read from tokens.css.
// Text needs >=4.5:1; the focus indicator (non-text) needs >=3:1 (WCAG 1.4.11).
// Values mirror packages/ui-mac/src/renderer/alpha-ui/tokens.css after #478.
const hex = h => { h=h.replace('#',''); if(h.length===3)h=h.split('').map(c=>c+c).join(''); return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)); };
const lin = c => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
const lum = ([r,g,b]) => 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
const ratio = (a,b) => { const L1=lum(hex(a)),L2=lum(hex(b)); const hi=Math.max(L1,L2),lo=Math.min(L1,L2); return (hi+0.05)/(lo+0.05); };

// LANDED token values (tokens.css). Light = :root; dark = [data-color-scheme=dark] + @media prefers dark (identical).
// #221 added --a-bg-inset to the pairing set (alpha-composer.css paints tertiary on it) and moved the
// light tertiary #6a6b73 -> #64656d, which is what that pairing needed to clear 4.5:1.
const THEMES = {
  light: { bg: { canvas:'#ffffff', subtle:'#f6f7f9', muted:'#eceef1', inset:'#e3e6ea', surface:'#ffffff', raised:'#ffffff' },
           accent:'#4f46e5', tertiary:'#64656d' },
  dark:  { bg: { canvas:'#0a0b0d', subtle:'#0e0f11', muted:'#16171a', inset:'#1e2024', surface:'#121316', raised:'#17181b' },
           accent:'#818cf8', tertiary:'#86878f' },
};

let failed = false;
for (const [name, t] of Object.entries(THEMES)) {
  console.log(`\n[${name}]`);
  // tertiary text vs every adjacent background (>=4.5:1)
  for (const [k, bg] of Object.entries(t.bg)) {
    const r = ratio(t.tertiary, bg), ok = r >= 4.5;
    if (!ok) failed = true;
    console.log(`  --a-text-tertiary ${t.tertiary} on ${k.padEnd(8)} ${bg}: ${r.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL (<4.5)'}`);
  }
  // focus ring = 1.5px solid --a-accent, vs every adjacent background (>=3:1)
  for (const [k, bg] of Object.entries(t.bg)) {
    const r = ratio(t.accent, bg), ok = r >= 3;
    if (!ok) failed = true;
    console.log(`  --a-ring-focus(accent) ${t.accent} on ${k.padEnd(8)} ${bg}: ${r.toFixed(2)}:1 ${ok ? 'PASS' : 'FAIL (<3)'}`);
  }
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: all pairings PASS');
process.exit(failed ? 1 : 0);
