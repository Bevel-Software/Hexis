/**
 * The page entry `harness.browser.ts` bundles: elements whose classes are the
 * kinds a naive split of the bundle breaks apart. An arbitrary value holding
 * parentheses and a comma, the bracketed variant the full-screen toolbars use,
 * and a shadow value with a comma inside `rgba(...)`.
 */
const host = document.getElementById('root');
if (!host) throw new Error('no #root to mount on');
host.innerHTML = `
  <div data-grid class="grid w-[400px] grid-cols-[repeat(2,1fr)]">
    <div data-cell="a">a</div>
    <div data-cell="b">b</div>
  </div>
  <div data-full-screen>
    <div data-slot class="[[data-full-screen]_&]:pr-9">slot</div>
  </div>
  <div data-shadow class="shadow-[0_0_0_3px_rgba(255,0,0,0.5)]">shadow</div>
`;
