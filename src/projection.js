/**
 * projection.js — task-scoped projection selection (Story 18)
 *
 * Given a loaded .kdna asset and a request shape, return a
 * task_projection object containing only the fragments relevant
 * to the task. NEVER return the full payload, full axioms, or
 * full ontology in one response — that is exactly what the
 * projection server is designed to prevent.
 *
 * Projection strategies (by task verb):
 *
 *   "review"     → constraints + self_checks + a few axioms
 *   "decide"     → highest_question + a few axioms + boundaries
 *   "explore"    → highest_question + a single axiom
 *   "audit"      → boundaries + self_checks (compliance posture)
 *   anything else → "minimal": highest_question only
 *
 * Per specs/kdna-runtime-projection.md §5:
 *   - Rate-limiting happens at the HTTP layer.
 *   - Extraction-pattern detection happens at the HTTP layer.
 *   - Audit events are emitted at the HTTP layer.
 *
 * The server adds no content-certification fields or claims. Selected asset
 * text is preserved verbatim: an asset may legitimately discuss words such
 * as "official" or "trusted", and this transport must not rewrite judgment.
 */

'use strict';

const MAX_AXIOMS_PER_PROJECTION = 3;
const MAX_CONSTRAINTS_PER_PROJECTION = 3;
const MAX_BOUNDARIES_PER_PROJECTION = 3;
const MAX_SELF_CHECKS_PER_PROJECTION = 3;
const MAX_FAILURE_MODES_PER_PROJECTION = 3;

function safeGet(content, key) {
  if (!content || typeof content !== 'object') return null;
  const v = content[key];
  if (!v) return null;
  if (Array.isArray(v) && v.length === 0) return null;
  return v;
}

function extractAxiomSentence(ax) {
  if (!ax) return null;
  if (typeof ax === 'string') return ax;
  if (typeof ax.one_sentence === 'string') return ax.one_sentence;
  if (typeof ax.full_statement === 'string') return ax.full_statement;
  if (typeof ax.statement === 'string') return ax.statement;
  return null;
}

function extractBoundaryText(b) {
  if (!b) return null;
  if (typeof b === 'string') return b;
  if (typeof b.scope === 'string') return b.scope;
  if (typeof b.description === 'string') return b.description;
  return null;
}

function extractSelfCheck(sc) {
  if (!sc) return null;
  if (typeof sc === 'string') return sc;
  if (typeof sc.question === 'string') return sc.question;
  if (typeof sc.one_sentence === 'string') return sc.one_sentence;
  return null;
}

function extractFailureMode(fm) {
  if (!fm) return null;
  if (typeof fm === 'string') return fm;
  if (typeof fm.mode === 'string') return fm.mode;
  if (typeof fm.name === 'string') return fm.name;
  if (typeof fm.description === 'string') return fm.description;
  return null;
}

function trimAxioms(axioms) {
  if (!Array.isArray(axioms)) return [];
  const out = [];
  for (const ax of axioms) {
    if (out.length >= MAX_AXIOMS_PER_PROJECTION) break;
    const s = extractAxiomSentence(ax);
    if (s) out.push(s);
  }
  return out;
}

function trimStrings(arr, max) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (out.length >= max) break;
    const s = typeof item === 'string'
      ? item
      : (extractBoundaryText(item) || extractSelfCheck(item) || extractFailureMode(item));
    if (s) out.push(s);
  }
  return out;
}

/**
 * Build a "review" projection: constraints + self-checks + a few axioms.
 */
function projectionReview(content) {
  const axioms = trimAxioms(safeGet(content, 'axioms'));
  const constraints = trimStrings(safeGet(content, 'boundaries') || safeGet(content, 'constraints'), MAX_CONSTRAINTS_PER_PROJECTION);
  const selfChecks = trimStrings(safeGet(content, 'self_checks') || safeGet(content, 'selfChecks'), MAX_SELF_CHECKS_PER_PROJECTION);
  return {
    diagnosis_focus: axioms,
    constraints,
    self_check: selfChecks,
  };
}

/**
 * Build a "decide" projection: highest_question + a few axioms + boundaries.
 */
function projectionDecide(content) {
  const hq = safeGet(content, 'highest_question');
  const axioms = trimAxioms(safeGet(content, 'axioms'));
  const boundaries = trimStrings(safeGet(content, 'boundaries'), MAX_BOUNDARIES_PER_PROJECTION);
  return {
    highest_question: typeof hq === 'string' ? hq : null,
    diagnosis_focus: axioms,
    constraints: boundaries,
  };
}

/**
 * Build an "explore" projection: highest_question + a single axiom.
 */
function projectionExplore(content) {
  const hq = safeGet(content, 'highest_question');
  const axioms = trimAxioms(safeGet(content, 'axioms')).slice(0, 1);
  return {
    highest_question: typeof hq === 'string' ? hq : null,
    diagnosis_focus: axioms,
  };
}

/**
 * Build an "audit" projection: boundaries + self-checks + failure modes.
 */
function projectionAudit(content) {
  return {
    constraints: trimStrings(safeGet(content, 'boundaries'), MAX_BOUNDARIES_PER_PROJECTION),
    self_check: trimStrings(safeGet(content, 'self_checks'), MAX_SELF_CHECKS_PER_PROJECTION),
    failure_modes: trimStrings(safeGet(content, 'failure_modes'), MAX_FAILURE_MODES_PER_PROJECTION),
  };
}

/**
 * Default "minimal" projection: highest_question only.
 */
function projectionMinimal(content) {
  const hq = safeGet(content, 'highest_question');
  return {
    highest_question: typeof hq === 'string' ? hq : null,
  };
}

function classifyTask(task) {
  const normalized = typeof task === 'string' ? task.toLowerCase() : '';
  if (/^review|^evaluate|^assess/.test(normalized)) return 'review';
  if (/^decide|^choose|^select/.test(normalized)) return 'decide';
  if (/^explore|^discover|^browse/.test(normalized)) return 'explore';
  if (/^audit|^comply|^check/.test(normalized)) return 'audit';
  return 'minimal';
}

/**
 * Project the asset to a task-scoped response.
 *
 * @param {object} asset — output of kdna-core's loadAuthorized()
 *   (has shape { content, asset_id, version, ... })
 * @param {object} req
 * @param {string} req.task
 * @param {string} [req.context]
 * @param {string} [req.mode]
 * @returns {object} task_projection (subset of content)
 */
function selectProjection(asset, req) {
  if (!asset || typeof asset !== 'object') {
    return projectionMinimal({});
  }
  const raw = asset.context || asset.content || asset;
  const payload = raw?.payload;
  const content = payload && typeof payload === 'object'
    ? {
        ...(payload.core || {}),
        patterns: payload.patterns || [],
        self_checks: payload.reasoning?.self_check || [],
        failure_modes: payload.reasoning?.failure_modes || [],
      }
    : raw;
  const taskClass = classifyTask(req && req.task);

  // Map task verb to a projection strategy. Unknown tasks fall
  // back to the minimal projection (highest_question only).
  let proj;
  if (taskClass === 'review') {
    proj = projectionReview(content);
  } else if (taskClass === 'decide') {
    proj = projectionDecide(content);
  } else if (taskClass === 'explore') {
    proj = projectionExplore(content);
  } else if (taskClass === 'audit') {
    proj = projectionAudit(content);
  } else {
    proj = projectionMinimal(content);
  }

  return proj;
}

module.exports = {
  selectProjection,
  projectionReview,
  projectionDecide,
  projectionExplore,
  projectionAudit,
  projectionMinimal,
  classifyTask,
};
