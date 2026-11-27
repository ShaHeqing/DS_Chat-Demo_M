/*
 * Sidebar swipe gestures for the Chat Demo WebView shell.
 *
 * The web bundle is prebuilt, and its sidebar is mounted lazily and has no
 * transition of its own. This script (injected by MainActivity) adds:
 *
 *   - closed: swipe right anywhere on the page to pull the sidebar in
 *             (text fields, horizontal scrollers and modal dialogs are ignored)
 *   - open:   swipe left on the sidebar (or on its invisible mask) to push it out
 *
 * The drawer follows the finger 1:1. On release it settles with a
 * velocity-aware spring. A new touch during the spring freezes the drawer
 * exactly where it is, so it can be grabbed and dragged either way instead of
 * waiting for the animation to finish. Taps and vertical scrolling are left
 * untouched.
 */
(function () {
    'use strict';

    if (window.__chatDemoSidebarSwipeInstalled) {
        return;
    }
    window.__chatDemoSidebarSwipeInstalled = true;

    var CLAIM_DX = 16;           // horizontal travel before the gesture is claimed
    var CLAIM_RATIO = 1.4;       // horizontal travel must beat vertical by this factor
    var LONG_PRESS_MS = 600;     // slower starts are treated as text selection, not a swipe
    var OPEN_THRESHOLD = 0.38;   // release past this fraction of the width opens
    var FLING_VELOCITY = 0.35;   // px per ms
    var SPRING_STIFFNESS = 1200; // 1/s^2
    var SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS); // critically damped
    var SPRING_REST_DISTANCE = 1;     // px
    var SPRING_REST_VELOCITY = 60;    // px per second
    var MAX_SPRING_STEP = 0.008;      // seconds per integration step
    var SWIPE_CLASS = 'chatdemo-sidebar-swiping';

    var gesture = null;
    var animation = null;
    var animationToken = 0;
    var pendingUnmountTimer = 0;
    var pendingUnmountToken = 0;
    var pendingRelease = null;
    var pendingReleaseTimer = 0;
    var suppressClickUntil = 0;
    var tapClickGuardUntil = 0;
    var tapClickGuardElement = null;
    var observer = null;

    function now() {
        return window.performance && window.performance.now
            ? window.performance.now()
            : Date.now();
    }

    function findButton(patterns) {
        var buttons = document.getElementsByTagName('button');
        for (var i = 0; i < buttons.length; i++) {
            var label = buttons[i].getAttribute('aria-label') || '';
            for (var j = 0; j < patterns.length; j++) {
                if (patterns[j].test(label)) {
                    return buttons[i];
                }
            }
        }
        return null;
    }

    function openButton() {
        return findButton([/open\s*sidebar/i, /打开边栏/, /展开边栏/]);
    }

    function closeButton() {
        return findButton([/close\s*sidebar/i, /收起边栏/, /关闭边栏/]);
    }

    // The drawer and its mask share the "drawer" prefix, but the mask is
    // "drawerMask-..." so it does not match this selector.
    function drawer() {
        return document.querySelector('[class*="drawer-"]:not([class*="drawerMask-"])');
    }

    function mask() {
        return document.querySelector('[class*="drawerMask-"]');
    }

    function isOpen() {
        return !!drawer();
    }

    function hasBlockingOverlay() {
        return !!document.querySelector(
            '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"]');
    }

    function isTextEntry(element) {
        if (!element || !element.closest) {
            return false;
        }
        return !!element.closest(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"]),' +
            '[role="textbox"]');
    }

    function isHorizontalScroller(element) {
        var node = element;
        while (node && node !== document.body && node !== document.documentElement) {
            var style = window.getComputedStyle(node);
            var overflowX = style.overflowX;
            if ((overflowX === 'auto' || overflowX === 'scroll')
                    && node.scrollWidth > node.clientWidth + 2) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    function canStartOpenSwipe(target) {
        if (!openButton() || hasBlockingOverlay()) {
            return false;
        }
        if (isTextEntry(target) || isHorizontalScroller(target)) {
            return false;
        }
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
                || active.tagName === 'SELECT')) {
            return false;
        }
        return true;
    }

    function translateX(element) {
        var transform = window.getComputedStyle(element).transform;
        if (!transform || transform === 'none') {
            return 0;
        }
        var match = transform.match(/^matrix(3d)?\((.+)\)$/);
        if (!match) {
            return 0;
        }
        var values = match[2].split(',');
        var x = parseFloat(match[1] ? values[12] : values[4]);
        return isNaN(x) ? 0 : x;
    }

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function isAttached(element) {
        return !!(element && document.documentElement
                && document.documentElement.contains(element));
    }

    function setTransform(element, x) {
        element.style.transition = 'none';
        element.style.willChange = 'transform';
        element.style.transform = 'translate3d(' + x + 'px, 0, 0)';
    }

    function clearStyles(element) {
        element.style.transition = '';
        element.style.willChange = '';
        element.style.transform = '';
    }

    function setSwiping(on) {
        if (on) {
            document.documentElement.classList.add(SWIPE_CLASS);
        } else {
            document.documentElement.classList.remove(SWIPE_CLASS);
        }
    }

    function drawerWidth() {
        var openDrawer = drawer();
        if (openDrawer) {
            var measured = openDrawer.getBoundingClientRect().width;
            if (measured > 0) {
                return measured;
            }
        }
        // Matches .mobile-ac14ac: width 300px; max-width calc(100vw - 48px)
        return Math.min(300, window.innerWidth - 48);
    }

    function clearPendingRelease() {
        if (pendingReleaseTimer) {
            clearTimeout(pendingReleaseTimer);
            pendingReleaseTimer = 0;
        }
        pendingRelease = null;
    }

    function cancelPendingUnmount() {
        pendingUnmountToken++;
        if (pendingUnmountTimer) {
            clearTimeout(pendingUnmountTimer);
            pendingUnmountTimer = 0;
        }
    }

    function cancelAnimation() {
        animationToken++;
        if (animation) {
            if (animation.raf) {
                cancelAnimationFrame(animation.raf);
            }
            animation = null;
        }
        cancelPendingUnmount();
    }

    function scheduleUnmount() {
        cancelPendingUnmount();
        var token = pendingUnmountToken;
        pendingUnmountTimer = setTimeout(function () {
            pendingUnmountTimer = 0;
            if (token !== pendingUnmountToken) {
                return;
            }
            var openDrawer = drawer();
            if (!openDrawer) {
                return;
            }
            // The mask owns the app's close action; a programmatic click is
            // not intercepted by the click handler below (it is not trusted).
            var clickTarget = mask();
            if (clickTarget) {
                clickTarget.click();
            } else {
                var button = closeButton();
                if (button) {
                    button.click();
                }
            }
            setTimeout(function () {
                if (token !== pendingUnmountToken) {
                    return;
                }
                // Only finish the drawer that was being closed; a new one may
                // have been opened in the meantime.
                var stillOpen = drawer();
                if (stillOpen && stillOpen === openDrawer) {
                    clearStyles(stillOpen);
                    var fallback = closeButton();
                    if (fallback) {
                        fallback.click();
                    }
                }
            }, 120);
        }, 0);
    }

    /**
     * Runs a critically damped spring from the drawer's current position to
     * target. velocity is in px/ms and carries the finger's fling into the
     * animation. At the closed edge the drawer is handed back to the app once
     * it is fully off-screen.
     */
    function springTo(element, target, velocity) {
        if (!element || !isAttached(element)) {
            return;
        }
        cancelAnimation();

        var width = element.getBoundingClientRect().width || drawerWidth();
        var min = -width;
        target = clamp(target, min, 0);

        var x = translateX(element);
        var v = (velocity || 0) * 1000;
        var token = animationToken;
        var last = now();
        var anim = {element: element, target: target, token: token, raf: 0};
        animation = anim;
        setTransform(element, x);

        function frame(t) {
            if (!animation || animation.token !== token) {
                return;
            }
            if (!isAttached(element) || element !== drawer()) {
                animation = null;
                return;
            }

            var dt = (t - last) / 1000;
            last = t;
            if (!isFinite(dt) || dt <= 0) {
                dt = 1 / 60;
            }
            dt = Math.min(dt, 0.05);

            var steps = Math.max(1, Math.ceil(dt / MAX_SPRING_STEP));
            var h = dt / steps;
            for (var i = 0; i < steps; i++) {
                var acceleration = -SPRING_STIFFNESS * (x - target)
                        - SPRING_DAMPING * v;
                v += acceleration * h;
                x += v * h;
                if (x > 0) {
                    x = 0;
                    if (v > 0) {
                        v = 0;
                    }
                } else if (x < min) {
                    x = min;
                    if (v < 0) {
                        v = 0;
                    }
                }
            }

            setTransform(element, x);

            if (Math.abs(x - target) < SPRING_REST_DISTANCE
                    && Math.abs(v) < SPRING_REST_VELOCITY) {
                setTransform(element, target);
                element.style.willChange = '';
                animation = null;
                anim.raf = 0;
                if (target <= min + 0.01) {
                    scheduleUnmount();
                }
                return;
            }
            anim.raf = requestAnimationFrame(frame);
        }

        anim.raf = requestAnimationFrame(frame);
    }

    function sampleVelocity(g) {
        var samples = g.samples;
        if (!samples || samples.length < 2) {
            return 0;
        }
        var last = samples[samples.length - 1];
        if (now() - last.t > 80) {
            return 0;
        }
        var first = last;
        for (var i = samples.length - 2; i >= 0; i--) {
            if (last.t - samples[i].t > 80) {
                break;
            }
            first = samples[i];
        }
        var dt = last.t - first.t;
        return dt > 0 ? (last.x - first.x) / dt : 0;
    }

    function targetFor(g, element) {
        var width = g.width || (element
            ? element.getBoundingClientRect().width
            : drawerWidth());
        var x = clamp(g.x, -width, 0);
        var progress = (x + width) / width;
        var velocity = sampleVelocity(g);
        if (velocity > FLING_VELOCITY) {
            return {x: 0, width: width, velocity: velocity};
        }
        if (velocity < -FLING_VELOCITY) {
            return {x: -width, width: width, velocity: velocity};
        }
        return {
            x: progress >= OPEN_THRESHOLD ? 0 : -width,
            width: width,
            velocity: velocity
        };
    }

    function finishWithoutClaim() {
        if (!gesture) {
            return;
        }
        var g = gesture;
        gesture = null;
        setSwiping(false);
        if (g.resumeTarget !== null && g.element && isAttached(g.element)) {
            springTo(g.element, g.resumeTarget, 0);
        }
    }

    function isTap(g) {
        return Math.abs(g.lastClientX - g.startX) <= 10
            && Math.abs(g.lastClientY - g.startY) <= 10
            && now() - g.startTime < 500;
    }

    function animateOpenFromButton() {
        var button = openButton();
        if (!button) {
            return false;
        }
        cancelPendingUnmount();
        clearPendingRelease();
        pendingRelease = {target: 0, velocity: 0, width: drawerWidth()};
        pendingReleaseTimer = setTimeout(function () {
            pendingReleaseTimer = 0;
            pendingRelease = null;
        }, 800);
        button.click();
        return true;
    }

    /**
     * WebView delays synthetic clicks by ~300ms. Handling taps that toggle the
     * sidebar in touchend makes the buttons feel immediate; the delayed click
     * is suppressed afterwards.
     */
    function guardTapClick(element) {
        tapClickGuardUntil = now() + 600;
        tapClickGuardElement = element;
    }

    function handleTapToggle(g) {
        if (!isTap(g)) {
            return false;
        }
        var target = g.target;
        if (!target || !target.closest) {
            return false;
        }
        if (!isOpen()) {
            var openBtn = openButton();
            if (openBtn && target.closest('button') === openBtn) {
                guardTapClick(openBtn);
                return animateOpenFromButton();
            }
            return false;
        }
        var closeBtn = closeButton();
        if ((closeBtn && target.closest('button') === closeBtn)
                || target.closest('[class*="drawerMask-"]')) {
            // The drawer (and possibly the mask) unmounts before the delayed
            // click arrives; suppress it globally so it cannot hit the page.
            suppressClickUntil = now() + 500;
            return closeWithAnimation();
        }
        return false;
    }

    function abortGesture() {
        if (!gesture) {
            return;
        }
        var g = gesture;
        var element = g.element || drawer();
        if (g.claimed && element && isAttached(element)) {
            var target = targetFor(g, element);
            gesture = null;
            setSwiping(false);
            springTo(element, target.x, target.velocity);
            return;
        }
        finishWithoutClaim();
    }

    function onTouchStart(event) {
        if (event.touches.length !== 1) {
            abortGesture();
            return;
        }

        var touch = event.touches[0];
        var open = isOpen();
        var mode = null;
        if (open) {
            mode = 'drag';
        } else if (canStartOpenSwipe(touch.target || event.target)) {
            mode = 'open';
        }
        if (!mode) {
            return;
        }

        // A previous close may still have its fallback unmount scheduled;
        // starting a new gesture supersedes it, even when the drawer is gone.
        cancelPendingUnmount();
        clearPendingRelease();

        var element = open ? drawer() : null;
        var width = element ? element.getBoundingClientRect().width : drawerWidth();
        var base = element ? translateX(element) : -width;
        var resumeTarget = null;

        if (element) {
            if (animation) {
                // Freeze a settle animation where it is; this touch will decide
                // whether to continue it or drag the drawer the other way.
                resumeTarget = animation.target;
                base = translateX(element);
                cancelAnimation();
                setTransform(element, base);
            } else {
                // If the close animation just finished, keep the drawer around
                // so it can be pulled back before the app unmounts it.
                cancelPendingUnmount();
                base = translateX(element);
                if (base <= -width + 0.5) {
                    resumeTarget = -width;
                }
            }
        }

        var time = now();
        gesture = {
            mode: mode,
            startX: touch.clientX,
            startY: touch.clientY,
            startTime: time,
            target: touch.target || event.target,
            lastClientX: touch.clientX,
            lastClientY: touch.clientY,
            samples: [{t: time, x: touch.clientX}],
            claimed: false,
            element: element,
            width: width,
            base: base,
            x: base,
            resumeTarget: resumeTarget
        };
    }

    function onTouchMove(event) {
        if (!gesture) {
            return;
        }
        if (event.touches.length !== 1) {
            abortGesture();
            return;
        }

        var touch = event.touches[0];
        var dx = touch.clientX - gesture.startX;
        var dy = touch.clientY - gesture.startY;
        gesture.lastClientX = touch.clientX;
        gesture.lastClientY = touch.clientY;

        var time = now();
        gesture.samples.push({t: time, x: touch.clientX});
        if (gesture.samples.length > 12) {
            gesture.samples.shift();
        }

        if (!gesture.claimed) {
            var horizontal = Math.abs(dx) > Math.abs(dy) * CLAIM_RATIO;

            if (!horizontal) {
                if (Math.abs(dy) > CLAIM_DX * 2 && Math.abs(dy) > Math.abs(dx)) {
                    finishWithoutClaim();
                }
                return;
            }

            if (gesture.mode === 'open') {
                if (dx < CLAIM_DX) {
                    return;
                }
                // A long press followed by a drag is text selection, not a swipe.
                if (now() - gesture.startTime > LONG_PRESS_MS || hasBlockingOverlay()) {
                    finishWithoutClaim();
                    return;
                }
                gesture.claimed = true;
                setSwiping(true);

                var button = openButton();
                if (button) {
                    button.click();
                }
                var openDrawer = drawer();
                if (openDrawer) {
                    gesture.element = openDrawer;
                    gesture.width = openDrawer.getBoundingClientRect().width
                        || gesture.width;
                    gesture.base = -gesture.width;
                } else {
                    // React mounts the drawer after the click; the mutation
                    // observer applies the first transform before paint.
                    gesture.base = -gesture.width;
                }
            } else {
                if (Math.abs(dx) < CLAIM_DX) {
                    return;
                }
                gesture.claimed = true;
                setSwiping(true);
            }
        }

        event.preventDefault();
        event.stopPropagation();

        var x = clamp(gesture.base + dx, -gesture.width, 0);
        gesture.x = x;
        if (!gesture.element) {
            gesture.element = drawer();
            if (gesture.element) {
                gesture.width = gesture.element.getBoundingClientRect().width
                    || gesture.width;
                gesture.base = -gesture.width;
                x = clamp(gesture.base + dx, -gesture.width, 0);
                gesture.x = x;
            }
        }
        if (gesture.element) {
            setTransform(gesture.element, x);
        }
    }

    function onTouchEnd(event) {
        if (!gesture) {
            return;
        }
        if (!gesture.claimed) {
            if (handleTapToggle(gesture)) {
                gesture = null;
                setSwiping(false);
                event.preventDefault();
                event.stopPropagation();
            } else {
                finishWithoutClaim();
            }
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        var finished = gesture;
        gesture = null;
        setSwiping(false);
        suppressClickUntil = now() + 250;

        var element = finished.element || drawer();
        var target = targetFor(finished, element);

        if (!element) {
            // The drawer has not mounted yet; finish as soon as it appears.
            clearPendingRelease();
            pendingRelease = {
                target: target.x,
                velocity: target.velocity,
                width: target.width
            };
            pendingReleaseTimer = setTimeout(function () {
                pendingReleaseTimer = 0;
                pendingRelease = null;
            }, 800);
            observeDrawerMounts();
            return;
        }

        springTo(element, target.x, target.velocity);
    }

    function onTouchCancel() {
        abortGesture();
    }

    function onDocumentClick(event) {
        if (!event.isTrusted) {
            return;
        }
        if (now() < suppressClickUntil) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        var target = event.target;
        if (!target || !target.closest) {
            return;
        }

        // Swallow the delayed click WebView generates after a sidebar tap,
        // but only if it lands on the element that was already handled.
        if (tapClickGuardElement && now() < tapClickGuardUntil) {
            var sameTarget = tapClickGuardElement.tagName === 'BUTTON'
                ? target.closest('button') === tapClickGuardElement
                : target.closest('[class*="drawerMask-"]') === tapClickGuardElement;
            if (sameTarget) {
                event.preventDefault();
                event.stopPropagation();
                tapClickGuardUntil = 0;
                tapClickGuardElement = null;
                return;
            }
        }

        if (!isOpen()) {
            // Keyboard/assistive clicks: animate the drawer in, just like a tap.
            var openBtn = openButton();
            if (openBtn && target.closest('button') === openBtn) {
                event.preventDefault();
                event.stopPropagation();
                animateOpenFromButton();
            }
            return;
        }

        // Tapping the close button or the mask animates the drawer out instead
        // of letting the app unmount it instantly.
        var closeBtn = closeButton();
        var clickedButton = target.closest('button');
        var clickedMask = target.closest('[class*="drawerMask-"]');
        if ((closeBtn && clickedButton === closeBtn) || clickedMask) {
            event.preventDefault();
            event.stopPropagation();
            closeWithAnimation();
        }
    }

    function observeDrawerMounts() {
        if (observer || !window.MutationObserver) {
            return;
        }
        observer = new MutationObserver(function () {
            var mounted = drawer();

            if (gesture && gesture.mode === 'open' && !gesture.element && mounted) {
                gesture.element = mounted;
                gesture.width = mounted.getBoundingClientRect().width || gesture.width;
                gesture.base = -gesture.width;
                gesture.x = clamp(
                    gesture.base + (gesture.lastClientX - gesture.startX),
                    -gesture.width,
                    0);
                setTransform(mounted, gesture.x);
                return;
            }

            if (pendingRelease && mounted) {
                var release = pendingRelease;
                clearPendingRelease();
                var width = mounted.getBoundingClientRect().width || release.width;
                setTransform(mounted, -width);
                if (release.target < 0) {
                    scheduleUnmount();
                } else {
                    springTo(mounted, 0, release.velocity);
                }
            }
        });
        observer.observe(document.documentElement, {childList: true, subtree: true});
    }

    function closeWithAnimation() {
        var openDrawer = drawer();
        if (!openDrawer) {
            return false;
        }
        springTo(openDrawer, -openDrawer.getBoundingClientRect().width, 0);
        return true;
    }

    // Used by MainActivity.onBackPressed so the system back gesture closes an
    // open sidebar (with the same animation) instead of leaving the app.
    window.__chatDemoSidebarSwipe = {
        isOpen: isOpen,
        close: closeWithAnimation
    };

    var style = document.createElement('style');
    style.textContent =
        'html.' + SWIPE_CLASS + ',html.' + SWIPE_CLASS + ' *{' +
        '-webkit-user-select:none!important;user-select:none!important;}';
    (document.head || document.documentElement).appendChild(style);

    observeDrawerMounts();

    document.addEventListener('touchstart', onTouchStart, {passive: true, capture: true});
    document.addEventListener('touchmove', onTouchMove, {passive: false, capture: true});
    document.addEventListener('touchend', onTouchEnd, {passive: false, capture: true});
    document.addEventListener('touchcancel', onTouchCancel, {passive: true, capture: true});
    document.addEventListener('click', onDocumentClick, true);
})();
