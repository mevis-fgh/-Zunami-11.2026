import { buildClientSchema, buildSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { badGateway, badRequest } from '../utils/errors.js';
import { truncateText } from '../utils/text.js';
import { buildSchemaGraph } from './graph.js';

/** Полный introspection-запрос (описания, deprecated, specifiedByUrl, inputValueDeprecation). */
export const INTROSPECTION_QUERY = getIntrospectionQuery({
  descriptions: true,
  schemaDescription: true,
  specifiedByUrl: true,
  directiveIsRepeatable: true,
  inputValueDeprecation: true,
});

/**
 * Загружает схему с GraphQL-эндпоинта через introspection.
 *
 * @param {{ endpoint: string, headers?: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ schema: import('graphql').GraphQLSchema, sdl: string, introspection: any }>}
 */
export async function introspectEndpoint({ endpoint, headers = {}, timeoutMs = 20000, fetchImpl = fetch }) {
  const url = normalizeHttpUrl(endpoint);
  const doFetch = fetchImpl;
  let response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'graphql-coverage-proxy/1.0',
        ...headers,
      },
      body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    throw badGateway(`Не удалось подключиться к ${url}: ${error?.message || error}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw badGateway(`Introspection вернул HTTP ${response.status}`, {
      endpoint: url,
      body: truncateText(text, 500),
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw badGateway('Introspection вернул не-JSON ответ', { body: truncateText(text, 500) });
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw badGateway('GraphQL-сервер вернул ошибки introspection', {
      errors: payload.errors.slice(0, 5),
    });
  }
  const introspection = payload?.data;
  if (!introspection || !introspection.__schema) {
    throw badGateway('В ответе нет data.__schema — endpoint не похож на GraphQL');
  }

  const schema = buildClientSchema(introspection);
  return { schema, sdl: printSchema(schema), introspection: introspection.__schema };
}

/**
 * Собирает схему из SDL-текста.
 *
 * @param {string} sdl
 */
export function schemaFromSdl(sdl) {
  if (typeof sdl !== 'string' || !sdl.trim()) {
    throw badRequest('SDL пустой');
  }
  if (sdl.length > 4 * 1024 * 1024) {
    throw badRequest('SDL слишком большой (максимум 4 МБ)');
  }
  try {
    const schema = buildSchema(sdl, { assumeValidSDL: false });
    // buildSchema не валидирует наличие Query и корректность связей до первого использования,
    // поэтому явно прогоняем базовую проверку.
    if (!schema.getQueryType()) throw new Error('В схеме отсутствует тип Query');
    const graph = buildSchemaGraph(schema);
    if (graph.stats.types === 0) throw new Error('SDL не содержит типов');
    return { schema, sdl, graph };
  } catch (error) {
    throw badRequest(`Некорректный SDL: ${error?.message || error}`);
  }
}

/**
 * Полный разбор SDL: схема + граф.
 * @param {string} sdl
 */
export function graphFromSdl(sdl) {
  const { schema, graph } = schemaFromSdl(sdl);
  return { schema, graph, sdl };
}

/**
 * @param {string} value
 */
export function normalizeHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw badRequest(`Некорректный URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Поддерживаются только http(s) URL');
  }
  return url.toString();
}
