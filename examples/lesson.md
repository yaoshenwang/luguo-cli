---
title: Slope of a line
summary: Find slope from two points and read the sign of k.
tags: [math, linear-functions]
visibility: private
language: en
---

# Slope of a line

A line's **slope** describes how y changes as x increases.

:::quiz What does a negative slope mean?
- [ ] the line is horizontal
- [x] the line falls from left to right
- [ ] the line must pass through the origin
@id q-slope-sign
@explain When k < 0, y decreases as x increases, so the line goes downhill.
@skills interpret slope sign
@steps inspect the sign of k,relate x and y changes,match the graph direction
:::

:::example Find the slope
A line passes through (0, 1) and (2, 5). What is its slope?
1. slope = (5 − 1) / (2 − 0)
2. = 4 / 2 = 2
@answer k = 2
:::

:::keypoints Core idea
- **slope k**: change in y divided by change in x
@skills calculate slope from points
:::

:::quiz What is the slope through (0, 1) and (2, 5)?
- [ ] 1
- [x] 2
- [ ] 4
@id q-slope-two-points
@explain The slope is (5 - 1) / (2 - 0) = 2.
@skills calculate slope from points
@steps calculate delta y,calculate delta x,divide delta y by delta x
:::

:::quiz Which equation has a horizontal graph?
- [x] y = 3
- [ ] y = 3x
- [ ] x = 3
@id q-slope-zero
@explain A horizontal line has slope zero, so y is constant.
@skills identify zero-slope equation
@steps identify a constant y-value,infer zero slope,exclude vertical lines
:::

:::tip Mnemonic
"Uphill is positive, downhill is negative" — imagine walking the line left to right.
:::

:::graph Draw the line y = 2x − 1
@id g-line-2x-1
```json
{ "prompt": "Drag the two points so the line shows y = 2x − 1", "equationTex": "y = 2x - 1", "viewBox": { "x": [-10, 10], "y": [-10, 10] }, "start": { "p1": [-4, 4], "p2": [4, 4] }, "answer": { "m": 2, "b": -1 }, "snap": true }
```
:::
