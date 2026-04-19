// src/classifier.js — small client-side helpers for presenting / reasoning
// about the context the server returned. The actual classification happens
// server-side in server/lib/gemini.js; this file only formats and validates.
//
// Kept on the client because plan.md lists it under src/, and because it
// contains no keys or third-party calls.

export const CONTEXTS = ['transit', 'medical', 'retail', 'outdoor', 'general'];

export const CONTEXT_LABELS = {
  transit: 'Transit',
  medical: 'Medical',
  retail: 'Retail',
  outdoor: 'Outdoor',
  general: 'General'
};

export const CONTEXT_ICONS = {
  transit: '🚌',
  medical: '🏥',
  retail: '🛒',
  outdoor: '🌳',
  general: '🏙'
};

export function normalizeContext(c) {
  return CONTEXTS.includes(c) ? c : 'general';
}

export function labelFor(context) {
  return CONTEXT_LABELS[normalizeContext(context)];
}

export function iconFor(context) {
  return CONTEXT_ICONS[normalizeContext(context)];
}
