import { useEffect, useRef } from "react";

// How fast stars travel toward the viewer, in z-units/second. Low on
// purpose -- this is an ambient bridge-viewscreen backdrop, not a warp jump.
const FLIGHT_SPEED = 0.05;
// How quickly the "heading" (the point stars stream out from/toward) eases
// toward the cursor. Low = a big ship slowly coming about, not a snappy
// cursor-follow.
const HEADING_EASE_PER_SEC = 0.6;
// Easter egg pacing: a random gap in this range (ms) between one ship
// crossing ending and the next one being scheduled.
const SHIP_MIN_GAP_MS = 45_000;
const SHIP_MAX_GAP_MS = 150_000;

function randomStar() {
  return {
    // Position on a unit square around the heading point, before the 1/z
    // projection below spreads it out toward the edges as it approaches.
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: 1,
    size: Math.random() < 0.8 ? 1 : 2,
    // Independent slow twinkle, layered on top of proximity brightness.
    phase: Math.random() * Math.PI * 2,
    speed: 0.25 + Math.random() * 0.5,
  };
}

/** Simplified top-down starship silhouette: saucer + hull + two nacelles.
 * Drawn nose-right in local space; caller translates/scales/flips it into
 * place. Deliberately abstracted (not a blueprint reproduction) -- it just
 * needs to read as "a ship" at the small, distant scale it's drawn at. */
function drawShip(ctx, scale, flip) {
  ctx.save();
  if (flip) ctx.scale(-1, 1);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(255,255,255,0.5)";

  // Engineering hull.
  ctx.beginPath();
  ctx.ellipse(-10, 4, 34, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Neck connecting hull to saucer.
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(28, -10);
  ctx.lineTo(34, -10);
  ctx.lineTo(26, 2);
  ctx.closePath();
  ctx.fill();

  // Saucer.
  ctx.beginPath();
  ctx.ellipse(40, -14, 22, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  // Pylons + nacelles, mirrored above/below the hull.
  for (const dy of [-16, 16]) {
    ctx.beginPath();
    ctx.moveTo(-6, dy * 0.35);
    ctx.lineTo(-2, dy);
    ctx.lineTo(6, dy);
    ctx.lineTo(2, dy * 0.35);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(-14, dy, 26, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Fixed full-viewport canvas: a slow "flying through space" starfield.
 * Each star has depth (z) and travels toward the viewer, projected outward
 * from a "heading" point the same way a ship's viewscreen would show stars
 * streaming past as it moves -- and that heading eases toward the cursor,
 * so the field slowly "steers" and zooms toward wherever you point.
 *
 * Also home to a rare easter egg: a simplified ship silhouette drifting
 * across the screen every couple of minutes.
 *
 * Plain canvas, no dependency: cheap to run, easy to read/debug.
 */
export default function StarBackground({ density = 0.00012 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let stars = [];
    let animationFrame;
    let running = true;

    const heading = { x: 0, y: 0 };
    const headingTarget = { x: 0, y: 0 };
    let headingInitialized = false;

    let ship = null; // { startT, duration, fromX, fromY, toX, toY, flip, scale }
    let nextShipAt = performance.now() + SHIP_MIN_GAP_MS + Math.random() * (SHIP_MAX_GAP_MS - SHIP_MIN_GAP_MS);

    function makeStars() {
      const count = Math.round(window.innerWidth * window.innerHeight * density);
      stars = new Array(count).fill(0).map(() => {
        const s = randomStar();
        // Scatter initial depth through the whole field instead of every
        // star starting equally far away, so the first frame already looks
        // like an established field rather than one big fan-out.
        s.z = 0.05 + Math.random() * 0.95;
        return s;
      });
    }

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      if (!headingInitialized) {
        heading.x = canvas.width / 2;
        heading.y = canvas.height / 2;
        headingTarget.x = heading.x;
        headingTarget.y = heading.y;
      }
      makeStars();
    }

    function handlePointerMove(e) {
      headingInitialized = true;
      headingTarget.x = e.clientX;
      headingTarget.y = e.clientY;
    }

    function scheduleNextShip(t) {
      nextShipAt = t + SHIP_MIN_GAP_MS + Math.random() * (SHIP_MAX_GAP_MS - SHIP_MIN_GAP_MS);
    }

    function spawnShip(t) {
      const goingRight = Math.random() < 0.5;
      const margin = 160;
      const y = canvas.height * (0.15 + Math.random() * 0.5);
      ship = {
        startT: t,
        duration: 20_000 + Math.random() * 12_000, // slow ambient crossing, 20-32s
        fromX: goingRight ? -margin : canvas.width + margin,
        toX: goingRight ? canvas.width + margin : -margin,
        fromY: y,
        toY: y + (Math.random() - 0.5) * canvas.height * 0.25,
        flip: !goingRight,
        scale: 0.8 + Math.random() * 0.7,
      };
    }

    let lastT = performance.now();

    function draw(t) {
      if (!running) return;
      const dt = Math.min((t - lastT) / 1000, 0.1);
      lastT = t;

      // Ease the heading toward the cursor -- frame-rate independent
      // exponential smoothing rather than a fixed-fraction lerp.
      const ease = 1 - Math.exp(-HEADING_EASE_PER_SEC * dt);
      heading.x += (headingTarget.x - heading.x) * ease;
      heading.y += (headingTarget.y - heading.y) * ease;

      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const scale = Math.min(canvas.width, canvas.height) * 0.5;

      for (const star of stars) {
        star.z -= FLIGHT_SPEED * dt;
        if (star.z <= 0.02) {
          Object.assign(star, randomStar());
        }
        star.phase += star.speed * dt;

        const px = heading.x + (star.x / star.z) * scale;
        const py = heading.y + (star.y / star.z) * scale;
        if (px < -4 || py < -4 || px > canvas.width + 4 || py > canvas.height + 4) continue;

        const proximity = 1 - star.z; // 0 (far) .. ~1 (about to pass the viewer)
        const twinkle = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(star.phase));
        const opacity = Math.min(1, twinkle * (0.35 + 0.65 * proximity));
        const size = star.size * Math.min(1 + proximity * 3, 4);

        ctx.fillStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
        ctx.fillRect(px, py, size, size);
      }

      if (!ship && t >= nextShipAt) {
        spawnShip(t);
      }
      if (ship) {
        const elapsed = t - ship.startT;
        if (elapsed >= ship.duration) {
          ship = null;
          scheduleNextShip(t);
        } else {
          const p = elapsed / ship.duration;
          const x = ship.fromX + (ship.toX - ship.fromX) * p;
          const y = ship.fromY + (ship.toY - ship.fromY) * p;
          ctx.save();
          ctx.translate(x, y);
          drawShip(ctx, ship.scale, ship.flip);
          ctx.restore();
        }
      }

      animationFrame = requestAnimationFrame(draw);
    }

    function handleVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(animationFrame);
      } else if (!running) {
        running = true;
        lastT = performance.now();
        animationFrame = requestAnimationFrame(draw);
      }
    }

    resize();
    animationFrame = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [density]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        zIndex: 0,
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
