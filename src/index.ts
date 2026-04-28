import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Operation,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  IntrinsicType,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface RpcInfo {
  name: string;
  originalName: string;
  path: string;
  inputType: Model | null;
  outputType: Model | null;
  isStream: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  serviceFQN: string;
  rpcs: RpcInfo[];
  models: Model[];
}

interface FileNames {
  types: string;
  server: string;
  client: string;
}

// ==================== Helpers ====================

function isStreamOp(_program: Program, op: Operation): boolean {
  const returnModel = op.returnType;
  if (returnModel && returnModel.kind === "Model" && returnModel.name && returnModel.name.includes("Stream")) return true;
  return false;
}

function resolveInputModel(op: Operation): Model | null {
  if (op.parameters && op.parameters.kind === "Model") {
    const params = op.parameters;
    if (params.name && params.name !== "") return params;
    if (params.sourceModels && params.sourceModels.length > 0) {
      for (const sm of params.sourceModels) {
        const src = sm.model;
        if (src.kind === "Model" && src.name && src.name !== "") return src;
      }
    }
    if (params.sourceModel && params.sourceModel.name && params.sourceModel.name !== "") {
      return params.sourceModel;
    }
  }
  return null;
}

function resolveOutputModel(op: Operation): Model | null {
  if (op.returnType && op.returnType.kind === "Model") return op.returnType;
  return null;
}

function computeProcedurePath(ns: Namespace, iface: Interface, op: Operation): string {
  const nsFQN = getNamespaceFullName(ns);
  return `/${nsFQN}.${iface.name}/${op.name}`;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const nsFQN = getNamespaceFullName(ns);
      const serviceName = iface.name;
      const rpcs: RpcInfo[] = [];
      const models: Model[] = [];
      const seen = new Set<string>();

      for (const [opName, op] of iface.operations) {
        const path = computeProcedurePath(ns, iface, op);
        const inputModel = resolveInputModel(op);
        const outputModel = resolveOutputModel(op);

        if (inputModel && inputModel.name && !seen.has(inputModel.name)) {
          models.push(inputModel);
          seen.add(inputModel.name);
        }
        if (outputModel && outputModel.name && !seen.has(outputModel.name)) {
          models.push(outputModel);
          seen.add(outputModel.name);
        }

        rpcs.push({ name: opName.charAt(0).toLowerCase() + opName.slice(1), originalName: opName, path, inputType: inputModel, outputType: outputModel, isStream: isStreamOp(program, op) });
      }

      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });

      result.push({ namespace: ns, iface, serviceName, serviceFQN: `${nsFQN}.${serviceName}`, rpcs, models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);

  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }

  return result;
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

// ==================== File Naming ====================

function snakeBase(s: string): string {
  return s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
}

function camelBase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function fileNamesFor(serviceName: string, lang: string): FileNames {
  const lower = camelBase(serviceName);
  const snake = snakeBase(serviceName);
  switch (lang) {
    case "go":
      return { types: `${snake}_types.go`, server: `${snake}_server.go`, client: `${snake}_client.go` };
    case "node":
      return { types: `${lower}.types.ts`, server: `${lower}.server.ts`, client: `${lower}.client.ts` };
    case "web":
      return { types: `${lower}.types.ts`, server: "", client: `${lower}.client.ts` };
    case "python":
      return { types: `${snake}_types.py`, server: `${snake}_server.py`, client: `${snake}_client.py` };
    case "rust":
      return { types: `${snake}_types.rs`, server: `${snake}_server.rs`, client: `${snake}_client.rs` };
    case "kotlin":
      return { types: `${serviceName}Types.kt`, server: "", client: `${serviceName}Client.kt` };
    case "swift":
      return { types: `${serviceName}Types.swift`, server: "", client: `${serviceName}Client.swift` };
    case "dart":
      return { types: `${snake}.types.dart`, server: "", client: `${snake}.client.dart` };
    default:
      return { types: `${snake}_types`, server: `${snake}_server`, client: `${snake}_client` };
  }
}

// ==================== Type Mappers ====================

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "string";
  if (type.kind === "Intrinsic") return (type as any).name === "string";
  return false;
}

function isIntType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "int8" || n === "int16" || n === "int32" || n === "int64" || n === "uint8" || n === "uint16" || n === "uint32" || n === "uint64" || n === "integer";
  }
  return false;
}

function isFloatType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "float" || n === "float32" || n === "float64" || n === "decimal";
  }
  return false;
}

function isBoolType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "boolean";
  if (type.kind === "Intrinsic") return (type as any).name === "boolean";
  return false;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToGo(type: Type): string {
  if (isStringType(type)) return "string";
  if (isIntType(type)) return "int64";
  if (isFloatType(type)) return "float64";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `[]${typeToGo(arrayElementType(type))}`;
  if (type.kind === "Model") return type.name || "any";
  return "any";
}

function typeToTs(type: Type): string {
  if (isStringType(type)) return "string";
  if (isIntType(type) || isFloatType(type)) return "number";
  if (isBoolType(type)) return "boolean";
  if (isArrayType(type)) return `${typeToTs(arrayElementType(type))}[]`;
  if (type.kind === "Model") return type.name || "unknown";
  return "unknown";
}

function typeToPython(type: Type): string {
  if (isStringType(type)) return "str";
  if (isIntType(type)) return "int";
  if (isFloatType(type)) return "float";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `list[${typeToPython(arrayElementType(type))}]`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToRust(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "i64";
  if (isFloatType(type)) return "f64";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `Vec<${typeToRust(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "serde_json::Value";
  return "serde_json::Value";
}

function typeToKotlin(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "Long";
  if (isFloatType(type)) return "Double";
  if (isBoolType(type)) return "Boolean";
  if (isArrayType(type)) return `List<${typeToKotlin(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToSwift(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "Int64";
  if (isFloatType(type)) return "Double";
  if (isBoolType(type)) return "Bool";
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type))}]`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function typeToDart(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "int";
  if (isFloatType(type)) return "double";
  if (isBoolType(type)) return "bool";
  if (isArrayType(type)) return `List<${typeToDart(arrayElementType(type))}>`;
  if (type.kind === "Model") return type.name || "dynamic";
  return "dynamic";
}

// ==================== Python Emitter ====================

function emitPython(program: Program, services: ServiceInfo[], outputDir: string): Promise<void[]> {
  const promises: Promise<void>[] = [];

  for (const svc of services) {
    if (svc.rpcs.length === 0) continue;
    const fn = fileNamesFor(svc.serviceName, "python");
    const importBase = fn.types.replace(/\.py$/, "");

    const types: string[] = [];
    types.push("# Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    types.push("from __future__ import annotations");
    types.push("import dataclasses\n");
    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);
      types.push("@dataclasses.dataclass");
      if (fields.length > 0) {
        types.push(`class ${m.name}:`);
        for (const f of fields) {
          types.push(`    ${f.name}: ${typeToPython(f.type)}${f.optional ? " | None = None" : ""}`);
        }
      } else {
        types.push(`class ${m.name}:`);
        types.push(`    pass`);
      }
      types.push('');
    }

    const server: string[] = [];
    server.push("# Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    server.push("from __future__ import annotations");
    server.push("from speconn import SpeconnRouter, SpeconnContext");
    server.push(`from ${importBase} import *\n`);
    server.push(`def create_router(service, interceptors=None) -> SpeconnRouter:`);
    server.push(`    router = SpeconnRouter(interceptors=interceptors)`);
    for (const rpc of svc.rpcs) {
      const inputName = rpc.inputType?.name || "dict";
      const outputName = rpc.outputType?.name || "dict";
      const method = rpc.isStream ? "server_stream" : "unary";
      server.push(`    router.${method}("${rpc.path}", ${inputName}, ${outputName})(service.${rpc.name})`);
    }
    server.push(`    return router`);
    server.push('');

    const client: string[] = [];
    client.push("# Generated by @speconn/typespec-speconn. DO NOT EDIT.\n");
    client.push("from __future__ import annotations");
    client.push("from speconn import SpeconnClient");
    client.push(`from ${importBase} import *\n`);
    client.push(`class ${svc.serviceName}Client(SpeconnClient):`);
    for (const rpc of svc.rpcs) {
      const inputName = rpc.inputType?.name || "dict";
      const outputName = rpc.outputType?.name || "dict";
      if (rpc.isStream) {
        client.push(`    async def ${rpc.name}(self, req: ${inputName}) -> list[${outputName}]:`);
        client.push(`        return await self.stream("${rpc.path}", req, ${outputName})`);
      } else {
        client.push(`    async def ${rpc.name}(self, req: ${inputName}) -> ${outputName}:`);
        client.push(`        return await self.call("${rpc.path}", req, ${outputName})`);
      }
    }
    client.push('');

    promises.push(emitFile(program, { path: `${outputDir}/${fn.types}`, content: types.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.server}`, content: server.join("\n") }));
    promises.push(emitFile(program, { path: `${outputDir}/${fn.client}`, content: client.join("\n") }));
  }
  return Promise.all(promises);
}

// ==================== Main Emitter ====================

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;

  const services = collectServices(program);

  await emitPython(program, services, outputDir);
}
