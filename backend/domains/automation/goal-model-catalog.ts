import { createHash } from 'node:crypto';
import { parseGoalModelReasoning, type GoalModel } from '../../../contracts/automation/goal-model-reasoning.js';
import { boundedResponseText } from './goal-response.js';
import { API_ATTRIBUTION_HEADERS } from '../providers/api-attribution.js';
import { apiProviderKey, configuredApiEndpoint, resolveApiBaseUrl } from '../providers/api-settings.js';
import { getConfig } from '../../infrastructure/settings/config.js';

const MODEL_LIST_TIMEOUT_MS = 30_000;
const MAX_MODEL_LIST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5_000;
const MAX_MODEL_FIELD_CHARS = 500;
const MODEL_CACHE_MS = 5 * 60_000;

export const MODEL_PAGE_SIZE = 20;

let modelCache: { at: number; keyScope: string; models: GoalModel[] } | null = null;

export function resetGoalModelCatalogCache(): void {
  modelCache = null;
}

export async function listGoalModels(
  offset = 0,
  limit = MODEL_PAGE_SIZE,
  query = ''
): Promise<{ models: GoalModel[]; total: number; selectedModel?: GoalModel }> {
  const selectedId = getConfig().goal.model;
  const models = await allGoalModels();
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? models.filter(model => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
    : models;
  const from = Math.max(0, Math.floor(offset));
  const count = Math.max(1, Math.min(100, Math.floor(limit)));
  const selectedModel = models.find(model => model.id === selectedId);
  return { models: visible.slice(from, from + count), total: visible.length, ...(selectedModel ? { selectedModel } : {}) };
}

async function allGoalModels(): Promise<GoalModel[]> {
  const endpoint = configuredApiEndpoint();
  const custom = endpoint.kind === 'custom';
  const key = await apiProviderKey(endpoint.kind);
  const keyScope = `${endpoint.kind}:${custom ? endpoint.baseUrl.trim() : ''}:${key ? createHash('sha256').update(key).digest('hex') : 'public'}`;
  if (modelCache && modelCache.keyScope === keyScope && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODEL_LIST_TIMEOUT_MS);
  let parsed: unknown;
  const label = custom ? 'custom provider' : endpoint.kind === 'openai' ? 'OpenAI' : 'OpenRouter';
  try {
    const baseUrl = resolveApiBaseUrl(endpoint);
    const response = await fetch(`${baseUrl}/models`, {
      redirect: 'error',
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(endpoint.kind === 'openrouter' ? API_ATTRIBUTION_HEADERS : {})
      },
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`${label} would not list its models (HTTP ${response.status})`);
    const raw = await boundedResponseText(response, MAX_MODEL_LIST_BODY_BYTES);
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`${label} returned a model list this app could not read`);
    }
  } catch (error) {
    if (custom) return [];
    if (abort.signal.aborted) throw new Error(`${label} model list request timed out`);
    if (error instanceof Error && error.message === 'response_body_too_large') {
      throw new Error(`${label} model list response body was too large`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const raw = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : null;
  if (!Array.isArray(raw)) {
    if (custom) return [];
    throw new Error(`${label} returned a model list this app could not read`);
  }

  const models: GoalModel[] = [];
  for (const entry of raw) {
    if (models.length >= MAX_MODELS) break;
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as { id?: unknown; name?: unknown; created?: unknown; context_length?: unknown; reasoning?: unknown };
    if (typeof model.id !== 'string' || model.id === '' || model.id.length > MAX_MODEL_FIELD_CHARS) continue;
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name ? model.name.slice(0, MAX_MODEL_FIELD_CHARS) : model.id,
      created: typeof model.created === 'number' && Number.isFinite(model.created) ? model.created : 0,
      ...(model.reasoning ? { reasoning: parseGoalModelReasoning(model.reasoning) } : {}),
      contextLength: typeof model.context_length === 'number' && Number.isFinite(model.context_length) ? model.context_length : 0
    });
  }

  models.sort((a, b) => (b.created - a.created) || a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), keyScope, models };
  return models;
}
