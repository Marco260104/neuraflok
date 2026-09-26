import { z } from 'zod';

function convertSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io });
}

type JsonSchema = ReturnType<typeof convertSchema>;
const schemas = new WeakMap<z.ZodType, Partial<Record<'input' | 'output', JsonSchema>>>();

export function toolSchemaJson(schema: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchema {
  let converted = schemas.get(schema);
  if (!converted) schemas.set(schema, converted = {});
  return converted[io] ??= convertSchema(schema, io);
}

const adapters = new WeakMap<z.ZodType, ReturnType<typeof createAdapter>>();

function createAdapter(schema: z.ZodType) {
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: (options: { target: string }) => options.target === 'draft-2020-12'
          ? toolSchemaJson(schema, 'input') : standard.jsonSchema.input(options),
        output: (options: { target: string }) => options.target === 'draft-2020-12'
          ? toolSchemaJson(schema, 'output') : standard.jsonSchema.output(options)
      }
    }
  };
}

export function toolSchema(schema: z.ZodType): ReturnType<typeof createAdapter> {
  let adapter = adapters.get(schema);
  if (!adapter) adapters.set(schema, adapter = createAdapter(schema));
  return adapter;
}
