# The four layers of design

Nico's decomposition. Use this vocabulary when discussing design with him.

Every visual decision belongs to exactly one layer. The layers are ordered by
dependency and by reusability, and those two orderings agree, which is the
sign the model is carved at a real joint rather than invented as a taxonomy.

---

## Layer 1: Primitives

Values with no shape.

Color tokens, type families and scale, spacing scale, radii, shadow set,
border weights, motion durations and easings, breakpoints.

A primitive has a role, not an appearance. "Cardinal is the only accent."
"Everything is serif." "Rounded-xl is the radius language." Nothing at this
layer is a thing a user can point at. It is the alphabet.

**Verified by** a spec sheet: swatches, a type ramp, a spacing ruler.

## Layer 2: Components

Primitives assembled into repeatable objects that carry state.

Button, input, card, nav item, badge, table row.

The decisions are anatomy (which parts), variants (primary, secondary,
ghost), states (rest, hover, focus, active, disabled, loading, error), and
sizes. A component is judged in isolation and against itself. It has no idea
what page it will land on.

**Verified by** a matrix: every variant crossed with every state, all
present, all consistent.

## Layer 3: Empty frame

Components arranged into a screen, with no real content.

This is where composition lives: the grid, the regions, what is sticky and
what scrolls, order, hierarchy, density, rhythm, where the eye lands first,
how it reflows across breakpoints.

It decides structure and priority. It deliberately does not decide whether
the content fits.

It is a wireframe, but rendered in real primitives and real components rather
than gray boxes, so the proportions are honest.

**Verified by** a set of breakpoints.

## Layer 4: Filled page

The frame carrying real content.

Real strings at real length, real numbers, real names, real image aspect
ratios, real row counts.

This is the only layer where truth shows up: overflow, wrapping, a name three
times longer than the mock, zero items, one item, ten thousand items, a
missing avatar, loading, error, empty state, pagination.

It decides what happens when the data misbehaves.

**Verified by** a set of data scenarios.

---

## The rules that make it a ladder

**Each layer is built only from the layer beneath it.** If a page needs a
color that is not in Layer 1, or a widget that is not in Layer 2, the correct
move is to go down and add it there, not to special-case it here. Every
special case is a layer violation, and a codebase full of them is how design
systems die.

**Diagnosis runs opposite to construction.** You build up, you debug down. A
page that looks wrong is usually a component problem. A component that looks
wrong is usually a token problem. Naming the layer before proposing a fix is
the highest-value habit in this whole model.

**Reusability drops and count rises as you climb.** A handful of primitives.
Dozens of components. Many frames. Unbounded filled states.

**Layers 1 and 2 are the design system. Layers 3 and 4 are product design.**
That is the real seam, and it is why the first two are shared across every
surface while the last two belong to a screen.

**Layer 4 is not one artifact.** One frame has N filled states and they are
all Layer 4. Designing "the page" means designing that whole set, not the
happy one. Shipping only the happy one is the most common way a design that
looked finished falls apart in production.

---

## What this model covers, and what it does not

**Complete** for anything visible in a single frozen frame. Every static
visual decision is a value, a reusable object, an arrangement, or a content
state. Nothing falls outside those four.

**Silent** on time and on navigation. Transitions between screens,
multi-step flows, optimistic updates, and the path a user takes across five
pages are real design decisions with no layer here. Motion tokens sit in
Layer 1 and hover states sit in Layer 2, but a page transition is none of the
four.

So it is a complete decomposition of visual composition, not of design as a
whole. When a task is about flow or motion over time, say so rather than
forcing it into a layer.

---

## Why this beats the standard model

Atomic Design splits by size: atom, molecule, organism. Size is a spectrum,
so the boundaries are permanently arguable and every team relitigates them.

This model splits Layer 3 from Layer 4 on presence of content, which is
binary and checkable. Either real data is in it or it is not. That is a sharp
joint, not a judgment call, and it is why the model survives contact with a
real codebase.
