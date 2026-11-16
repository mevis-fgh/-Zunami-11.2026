import {
  Kind,
  getNamedType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
  parse,
  validate,
} from 'graphql';

const MAX_SELECTION_DEPTH = 64;
const ROOT_FALLBACK = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };

/**
 * Разбирает GraphQL-документ и сопоставляет его со схемой.
 *
 * Поддерживает:
 *  - queries / mutations / subscriptions;
 *  - алиасы (в покрытие пишется реальное имя поля, алиас сохраняется отдельно);
 *  - именованные фрагменты и inline fragments;
 *  - переменные (аргументы, значения которых — переменные, тоже считаются использованными);
 *  - вложенные input-объекты в литералах аргументов;
 *  - директивы;
 *  - дедупликацию повторных выборок внутри одного запроса.
 *
 * @param {{
 *   query: string,
 *   schema?: import('graphql').GraphQLSchema | null,
 *   operationName?: string | null,
 *   maxDepth?: number,
 * }} options
 */
export function analyzeDocument({ query, schema = null, operationName = null, maxDepth = MAX_SELECTION_DEPTH }) {
  /** @type {any} */
  const result = {
    parsed: false,
    valid: false,
    errors: [],
    operations: [],
    fields: [],
    args: [],
    inputs: [],
    variables: [],
    fragments: [],
    directives: [],
    unresolved: [],
    maxDepth: 0,
    totals: { selections: 0, fields: 0, args: 0, inputs: 0, operations: 0 },
  };

  if (typeof query !== 'string' || query.trim() === '') {
    result.errors.push({ message: 'Пустой GraphQL-запрос', code: 'EMPTY_QUERY' });
    return result;
  }
  if (query.length > 500000) {
    result.errors.push({ message: 'Запрос слишком большой', code: 'QUERY_TOO_LARGE' });
    return result;
  }

  /** @type {import('graphql').DocumentNode} */
  let document;
  try {
    document = parse(query);
  } catch (error) {
    result.errors.push({
      message: error?.message || String(error),
      code: 'PARSE_ERROR',
      locations: error?.locations,
    });
    return result;
  }
  result.parsed = true;

  if (schema) {
    try {
      const validationErrors = validate(schema, document);
      for (const error of validationErrors) {
        result.errors.push({ message: error.message, code: 'VALIDATION_ERROR', locations: error.locations });
      }
    } catch (error) {
      result.errors.push({ message: `Ошибка валидации: ${error?.message || error}`, code: 'VALIDATION_CRASH' });
    }
  }
  result.valid = result.parsed && !result.errors.some((error) => error.code === 'VALIDATION_ERROR' || error.code === 'PARSE_ERROR');

  /** @type {Map<string, import('graphql').FragmentDefinitionNode>} */
  const fragments = new Map();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }

  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) {
    result.errors.push({ message: 'В документе нет операций', code: 'NO_OPERATIONS' });
    result.valid = false;
    return result;
  }
  if (operations.length > 1 && !operationName) {
    result.errors.push({
      message: 'Документ содержит несколько операций — укажите operationName',
      code: 'OPERATION_NAME_REQUIRED',
    });
    result.valid = false;
  }

  /** @type {Set<string>} */
  const directiveNames = new Set();
  /** @type {Set<string>} */
  const touchedVariables = new Set();

  for (const operation of operations) {
    const opType = operation.operation || 'query';
    const name = operation.name?.value || null;
    const executed = !operationName || name === operationName;
    const rootType = resolveRootType(schema, opType);
    const rootName = rootType?.name || ROOT_FALLBACK[opType] || 'Query';
    const opKey = `${opType}${name ? ` ${name}` : ''}`;

    for (const directive of operation.directives || []) directiveNames.add(directive.name.value);

    const variableDefinitions = (operation.variableDefinitions || []).map((definition) => ({
      name: definition.variable.name.value,
      type: String(definition.type),
      defaultValue: Boolean(definition.defaultValue),
    }));
    for (const definition of variableDefinitions) {
      result.variables.push({ ...definition, used: false });
    }

    const ctx = {
      result,
      schema,
      opType,
      opName: name,
      opKey,
      rootName,
      executed,
      fragments,
      seen: new Set(),
      fragmentUsage: new Map(),
      fragmentStack: new Set(),
      maxDepth: 0,
      depthCap: maxDepth,
      touchedVariables,
      directiveNames,
      operationsTouched: 0,
    };

    if (rootType || !schema) {
      walkSelectionSet(operation.selectionSet, rootName, ctx, [], 1);
    } else {
      result.errors.push({
        message: `Схема не поддерживает операцию ${opType}`,
        code: 'UNSUPPORTED_OPERATION',
      });
    }

    result.operations.push({
      key: opKey,
      type: opType,
      name,
      executed,
      rootType: rootName,
      depth: ctx.maxDepth,
      fieldCount: ctx.operationsTouched,
      variables: variableDefinitions.map((item) => item.name),
      fragmentCount: ctx.fragmentUsage.size,
    });
    result.maxDepth = Math.max(result.maxDepth, ctx.maxDepth);
  }

  for (const variable of result.variables) variable.used = touchedVariables.has(variable.name);

  for (const [name, fragment] of fragments) {
    result.fragments.push({
      name,
      typeCondition: fragment.typeCondition?.name.value || null,
      usage: countFragmentUsage(document, name),
    });
  }
  result.directives = [...directiveNames].sort();

  const resolvedFields = result.fields.filter((field) => field.resolved);
  result.totals = {
    selections: result.fields.length,
    fields: new Set(resolvedFields.map((field) => field.key)).size,
    args: new Set(result.args.filter((arg) => arg.resolved).map((arg) => arg.key)).size,
    inputs: new Set(result.inputs.map((input) => input.key)).size,
    operations: result.operations.length,
    unresolved: result.unresolved.length,
  };
  return result;
}

/** @param {any} schema @param {string} opType */
function resolveRootType(schema, opType) {
  if (!schema) return null;
  if (opType === 'mutation') return schema.getMutationType();
  if (opType === 'subscription') return schema.getSubscriptionType();
  return schema.getQueryType();
}

/** @param {any} type */
function isComposite(type) {
  return Boolean(type) && (isObjectType(type) || isInterfaceType(type) || isUnionType(type));
}

/**
 * @param {import('graphql').SelectionSetNode} selectionSet
 * @param {string} typeName
 * @param {any} ctx
 * @param {string[]} path
 * @param {number} depth
 */
function walkSelectionSet(selectionSet, typeName, ctx, path, depth) {
  if (!selectionSet || depth > ctx.depthCap) return;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      visitField(selection, typeName, ctx, path, depth);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      for (const directive of selection.directives || []) ctx.directiveNames.add(directive.name.value);
      const condition = selection.typeCondition?.name.value || typeName;
      walkSelectionSet(selection.selectionSet, condition, ctx, path, depth);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      for (const directive of selection.directives || []) ctx.directiveNames.add(directive.name.value);
      const fragmentName = selection.name.value;
      const fragment = ctx.fragments.get(fragmentName);
      if (!fragment) {
        ctx.result.errors.push({ message: `Неизвестный фрагмент "${fragmentName}"`, code: 'UNKNOWN_FRAGMENT' });
        continue;
      }
      if (ctx.fragmentStack.has(fragmentName)) continue;
      ctx.fragmentStack.add(fragmentName);
      ctx.fragmentUsage.set(fragmentName, (ctx.fragmentUsage.get(fragmentName) || 0) + 1);
      walkSelectionSet(fragment.selectionSet, fragment.typeCondition?.name.value || typeName, ctx, path, depth);
      ctx.fragmentStack.delete(fragmentName);
    }
  }
}

/**
 * @param {import('graphql').FieldNode} node
 * @param {string} typeName
 * @param {any} ctx
 * @param {string[]} path
 * @param {number} depth
 */
function visitField(node, typeName, ctx, path, depth) {
  const name = node.name.value;
  if (name.startsWith('__')) return; // introspection-поля не считаем покрытием

  const alias = node.alias?.value || null;
  const nodePath = [...path, alias || name];
  const fieldPath = nodePath.join('.');
  if (ctx.seen.has(fieldPath)) return;
  ctx.seen.add(fieldPath);

  for (const directive of node.directives || []) ctx.directiveNames.add(directive.name.value);

  const key = `${typeName}.${name}`;
  const parentType = ctx.schema ? ctx.schema.getType(typeName) : null;
  let fieldDef = null;
  if (parentType && (isObjectType(parentType) || isInterfaceType(parentType))) {
    fieldDef = parentType.getFields()[name] || null;
  }

  if (!fieldDef) {
    ctx.result.fields.push({
      type: typeName,
      field: name,
      key,
      path: fieldPath,
      depth,
      alias,
      operation: ctx.opKey,
      executed: ctx.executed,
      resolved: false,
      reason: parentType ? 'FIELD_NOT_IN_SCHEMA' : 'UNKNOWN_TYPE',
    });
    ctx.result.unresolved.push({
      type: typeName,
      field: name,
      path: fieldPath,
      reason: parentType ? 'FIELD_NOT_IN_SCHEMA' : 'UNKNOWN_TYPE',
    });
    return;
  }

  const returnType = String(fieldDef.type);
  ctx.operationsTouched += 1;
  ctx.maxDepth = Math.max(ctx.maxDepth, depth);
  ctx.result.fields.push({
    type: typeName,
    field: name,
    key,
    path: fieldPath,
    depth,
    alias,
    returnType,
    args: (node.arguments || []).map((argument) => argument.name.value),
    operation: ctx.opKey,
    executed: ctx.executed,
    resolved: true,
  });

  for (const argumentNode of node.arguments || []) {
    const argName = argumentNode.name.value;
    const argDef = fieldDef.args.find((argument) => argument.name === argName) || null;
    const isVariable = argumentNode.value.kind === Kind.VARIABLE;
    const variableName = isVariable ? argumentNode.value.name.value : null;
    if (variableName) ctx.touchedVariables.add(variableName);

    ctx.result.args.push({
      key: `${key}.${argName}`,
      type: typeName,
      field: name,
      arg: argName,
      valueKind: argumentNode.value.kind,
      variable: variableName,
      operation: ctx.opKey,
      executed: ctx.executed,
      resolved: Boolean(argDef),
    });

    if (argDef) {
      walkInputValue(argumentNode.value, argDef.type, ctx, fieldPath, argName);
    }
  }

  if (node.selectionSet && node.selectionSet.selections.length > 0) {
    const named = getNamedType(fieldDef.type);
    if (isComposite(named)) {
      walkSelectionSet(node.selectionSet, named.name, ctx, nodePath, depth + 1);
    }
  }
}

/**
 * Разбирает литеральные значения аргументов: объекты input-типов, списки, переменные.
 * @param {import('graphql').ValueNode} valueNode
 * @param {import('graphql').GraphQLInputType} inputType
 * @param {any} ctx
 * @param {string} path
 * @param {string} argName
 */
function walkInputValue(valueNode, inputType, ctx, path, argName) {
  if (!valueNode) return;
  let type = inputType;
  while (isNonNullType(type) || isListType(type)) {
    if (valueNode.kind === Kind.LIST && isListType(type)) {
      for (const item of valueNode.values) walkInputValue(item, type.ofType, ctx, path, argName);
      return;
    }
    type = type.ofType;
  }

  if (valueNode.kind === Kind.VARIABLE) {
    ctx.touchedVariables.add(valueNode.name.value);
    return;
  }

  if (isInputObjectType(type) && valueNode.kind === Kind.OBJECT) {
    for (const fieldNode of valueNode.fields) {
      const fieldName = fieldNode.name.value;
      const inputField = type.getFields()[fieldName] || null;
      ctx.result.inputs.push({
        key: `${type.name}.${fieldName}`,
        inputType: type.name,
        field: fieldName,
        path: `${path}.${argName}.${fieldName}`,
        operation: ctx.opKey,
        executed: ctx.executed,
        resolved: Boolean(inputField),
      });
      if (inputField) {
        walkInputValue(fieldNode.value, inputField.type, ctx, `${path}.${argName}.${fieldName}`, argName);
      }
    }
  }
}

/**
 * Сколько раз фрагмент реально spread-ится в документе.
 * @param {import('graphql').DocumentNode} document
 * @param {string} fragmentName
 */
function countFragmentUsage(document, fragmentName) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === Kind.FRAGMENT_SPREAD && node.name?.value === fragmentName) count += 1;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (child && typeof child === 'object' && typeof child.kind === 'string') {
        visit(child);
      }
    }
  };
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) visit(definition.selectionSet);
  }
  return count;
}

/**
 * Компактная выжимка анализа для журнала исполнений.
 * @param {any} analysis
 */
export function summarizeAnalysis(analysis) {
  const executedFields = analysis.fields.filter((field) => field.resolved && field.executed !== false);
  const executedArgs = analysis.args.filter((arg) => arg.resolved && arg.executed !== false);
  const fieldKeys = [...new Set(executedFields.map((field) => field.key))];
  const argKeys = [...new Set(executedArgs.map((arg) => arg.key))];
  return {
    parsed: analysis.parsed,
    valid: analysis.valid,
    errorCount: analysis.errors.length,
    errors: analysis.errors.slice(0, 5).map((error) => ({ code: error.code, message: error.message })),
    fieldCount: fieldKeys.length,
    fields: fieldKeys.slice(0, 400),
    argCount: argKeys.length,
    args: argKeys.slice(0, 200),
    operationKeys: analysis.operations.filter((operation) => operation.executed).map((operation) => operation.key),
    maxDepth: analysis.maxDepth,
    unresolvedCount: analysis.unresolved.length,
    variables: analysis.variables.map((variable) => variable.name),
    fragments: analysis.fragments.map((fragment) => fragment.name),
    directives: analysis.directives,
  };
}
