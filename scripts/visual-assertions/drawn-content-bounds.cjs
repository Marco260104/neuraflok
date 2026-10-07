'use strict';

const assert = require('node:assert/strict');

async function readElementBox(js, expression) {
  await js(`${expression}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return js(`(() => {
    const element = ${expression};
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      border: parseFloat(style.borderTopWidth) || 0,
      round: parseFloat(style.borderTopLeftRadius) >= rect.width / 2 - 1
    };
  })()`);
}

function captureRectFor(box) {
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  return {
    x,
    y,
    width: Math.ceil(box.x + box.width) - x,
    height: Math.ceil(box.y + box.height) - y
  };
}

function readRgb(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
}

function median(values) {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function estimateBackground(bitmap, width, bounds, round) {
  const colors = [[], [], []];
  const band = Math.max(2, Math.ceil(Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) * 0.08));
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const radiusX = (bounds.right - bounds.left) / 2;
  const radiusY = (bounds.bottom - bounds.top) / 2;

  for (let y = Math.ceil(bounds.top); y < bounds.bottom; y += 1) {
    for (let x = Math.ceil(bounds.left); x < bounds.right; x += 1) {
      if (round && ((x + 0.5 - centerX) / radiusX) ** 2 + ((y + 0.5 - centerY) / radiusY) ** 2 > 1) continue;
      const nearEdge = x - bounds.left < band || bounds.right - x <= band || y - bounds.top < band || bounds.bottom - y <= band;
      if (!nearEdge) continue;
      const color = readRgb(bitmap, width, x, y);
      for (let channel = 0; channel < 3; channel += 1) colors[channel].push(color[channel]);
    }
  }

  assert.ok(colors[0].length, 'The element has a measurable interior');
  return colors.map(median);
}

function isInsideShape(x, y, bounds, round) {
  if (!round) return true;
  const radiusX = (bounds.right - bounds.left) / 2;
  const radiusY = (bounds.bottom - bounds.top) / 2;
  const offsetX = (x + 0.5 - (bounds.left + bounds.right) / 2) / radiusX;
  const offsetY = (y + 0.5 - (bounds.top + bounds.bottom) / 2) / radiusY;
  return offsetX ** 2 + offsetY ** 2 <= 1;
}

function colorDistance(left, right) {
  const red = left[0] - right[0];
  const green = left[1] - right[1];
  const blue = left[2] - right[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function measureInk(bitmap, width, bounds, background, round) {
  let strongest = 0;
  for (let y = Math.ceil(bounds.top); y < bounds.bottom; y += 1) {
    for (let x = Math.ceil(bounds.left); x < bounds.right; x += 1) {
      if (!isInsideShape(x, y, bounds, round)) continue;
      strongest = Math.max(strongest, colorDistance(readRgb(bitmap, width, x, y), background));
    }
  }

  const threshold = Math.max(28, strongest * 0.32);
  const pixels = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let y = Math.ceil(bounds.top); y < bounds.bottom; y += 1) {
    for (let x = Math.ceil(bounds.left); x < bounds.right; x += 1) {
      if (!isInsideShape(x, y, bounds, round)) continue;
      if (colorDistance(readRgb(bitmap, width, x, y), background) <= threshold) continue;
      pixels.left = Math.min(pixels.left, x);
      pixels.top = Math.min(pixels.top, y);
      pixels.right = Math.max(pixels.right, x + 1);
      pixels.bottom = Math.max(pixels.bottom, y + 1);
    }
  }

  assert.ok(Number.isFinite(pixels.left), 'The element contains visible drawing');
  return pixels;
}

async function drawnContentInsets(win, js, expression) {
  const box = await readElementBox(js, expression);
  const rect = captureRectFor(box);
  const image = await win.webContents.capturePage(rect);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const scaleX = size.width / rect.width;
  const scaleY = size.height / rect.height;
  const bounds = {
    left: (box.x - rect.x + box.border + 1) * scaleX,
    top: (box.y - rect.y + box.border + 1) * scaleY,
    right: (box.x - rect.x + box.width - box.border - 1) * scaleX,
    bottom: (box.y - rect.y + box.height - box.border - 1) * scaleY
  };
  const background = estimateBackground(bitmap, size.width, bounds, box.round);
  const pixels = measureInk(bitmap, size.width, bounds, background, box.round);

  return {
    left: (pixels.left - bounds.left) / scaleX,
    right: (bounds.right - pixels.right) / scaleX,
    top: (pixels.top - bounds.top) / scaleY,
    bottom: (bounds.bottom - pixels.bottom) / scaleY
  };
}

module.exports = { drawnContentInsets };
