# Mobile Nav Drawer (sidebar → drawer) — Design + Plan

> UI-only, additive. No business logic / API / route changes. Touches `web/src/components/layout/AppShell.tsx` only (highest-blast-radius component → heavy verification).

## Problem
The 220px sidebar is always visible (no responsive collapse). At <~1024px viewports it eats half the screen + forces topbar/content overflow. Phase-8 follow-up: give the app a proper mobile nav.

## Design
- **Breakpoint `lg` (1024px):** ≥1024 sidebar is `static` + always visible (desktop **unchanged**). <1024 → hamburger-triggered slide-in drawer.
- **Critical safety property — off-canvas transform, NOT `display:none`:** existing AppShell tests use `getByRole('link', {name})`, which excludes `display:none`/`aria-hidden` elements. Hiding the sidebar with `hidden lg:flex` would break every nav-link test in jsdom (base viewport). Instead the sidebar is ALWAYS rendered and merely translated off-canvas (`-translate-x-full`) on mobile — a transformed element stays in the accessibility tree, so `getByRole` still finds the links. ONE `<aside>` (no nav duplication).
- **Close on:** route change (covers nav-link clicks — no per-link handler needed), Escape, backdrop click.
- Body-scroll-lock while the drawer is open on mobile.

## Tasks

### Task 1: mobile-nav state + drawer behavior
**File:** `web/src/components/layout/AppShell.tsx`
- [ ] Add `useLocation` to the `react-router-dom` import (line 2) and `Menu` to the `lucide-react` import (line 4-14).
- [ ] In the component body add:
  ```ts
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const location = useLocation();
  // close the drawer whenever the route changes (covers nav-link clicks)
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);
  // Escape closes + body-scroll-lock while open
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [mobileNavOpen]);
  ```
- [ ] Change the `<aside>` className from
  `"w-[220px] shrink-0 bg-white flex flex-col border-r border-[#E5E7EB]"`
  to (use `cn(...)`):
  ```ts
  cn(
    'w-[220px] shrink-0 bg-white flex flex-col border-r border-[#E5E7EB]',
    'fixed inset-y-0 left-0 z-40 transition-transform duration-200',
    'lg:static lg:z-auto lg:translate-x-0',
    mobileNavOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full lg:shadow-none',
  )
  ```
  and add `data-testid="primary-sidebar"` to the `<aside>`.
- [ ] Immediately AFTER the `</aside>` (before the main-area `<div className="flex-1 flex flex-col min-w-0">`), add the mobile backdrop:
  ```tsx
  {mobileNavOpen && (
    <div
      className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
      onClick={() => setMobileNavOpen(false)}
      data-testid="mobile-nav-backdrop"
      aria-hidden
    />
  )}
  ```
- [ ] In the topbar LEFT cluster (the `<div className="flex items-center gap-3 min-w-0">` at ~line 247), add a hamburger as the FIRST child:
  ```tsx
  <button
    type="button"
    onClick={() => setMobileNavOpen(true)}
    className="lg:hidden -ml-1 rounded-[8px] p-2 text-[#6B7280] hover:bg-[#F5F7FA] hover:text-[#4F46E5] transition-colors"
    aria-label="Open navigation"
    data-testid="mobile-nav-toggle"
  >
    <Menu size={18} strokeWidth={2} />
  </button>
  ```

### Task 2: tests
**File:** `web/src/__tests__/AppShellMobileNav.test.tsx` (new)
- [ ] Write tests (render AppShell the same way `AppShell.test.tsx` does — copy its render harness/providers + a logged-in user):
  - hamburger toggle present (`getByTestId('mobile-nav-toggle')`).
  - sidebar starts off-canvas: `getByTestId('primary-sidebar').className` contains `-translate-x-full` and NOT `translate-x-0` (the open class) initially.
  - click hamburger → sidebar className now contains `translate-x-0` (without the `-translate-x-full` lead) + `mobile-nav-backdrop` appears.
  - click backdrop → sidebar back to `-translate-x-full`, backdrop gone.
  - nav links STILL queryable while closed: `getByRole('link', { name: /^dashboard$/i })` resolves (proves off-canvas ≠ hidden).
- [ ] Run → pass.

### Verify
- [ ] `npx vitest run src/__tests__/AppShell.test.tsx src/__tests__/AppShellNavGroups.test.tsx src/__tests__/AppShellMobileNav.test.tsx` → all green (existing two UNCHANGED).
- [ ] `npx tsc --noEmit` excl-handlers = 0.
- [ ] Full `npx vitest run` green (AppShell is global).
- [ ] Playwright live: at 480 → hamburger visible, drawer opens/closes (backdrop + Esc + nav-click), no page h-scroll; at 1280 → no hamburger, sidebar static-visible, no behavioral change.
- [ ] Commit + push.
