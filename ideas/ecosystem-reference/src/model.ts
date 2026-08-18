export interface LayerDefinition {
	id: string;
	parent?: string;
	identityFields: string[];
	terminal?: boolean;
}

export interface ScopeRef {
	app: string;
	layer: string;
	id: string;
	attributes?: Readonly<Record<string, string>>;
}

export type ScopePath = readonly ScopeRef[];

export interface OperationDefinition<Input> {
	id: string;
	effect: "read" | "write";
	onLayer: string;
	validateInput(input: unknown): input is Input;
}

export interface AppDefinition<Event> {
	id: string;
	version: string;
	layers: readonly LayerDefinition[];
	operations: readonly OperationDefinition<unknown>[];
	normalize(input: unknown): Event;
	resolveScope(event: Event): ScopePath;
}

function assertNonEmpty(value: string, label: string): void {
	if (!value.trim()) throw new Error(`${label} must not be empty`);
}

export function defineApp<Event>(definition: AppDefinition<Event>): Readonly<AppDefinition<Event>> {
	assertNonEmpty(definition.id, "app id");
	assertNonEmpty(definition.version, "app version");

	const layers = new Map<string, LayerDefinition>();
	for (const layer of definition.layers) {
		assertNonEmpty(layer.id, "layer id");
		if (layers.has(layer.id)) throw new Error(`duplicate layer: ${layer.id}`);
		if (layer.identityFields.length === 0) throw new Error(`layer ${layer.id} needs identity fields`);
		layers.set(layer.id, layer);
	}

	const roots = definition.layers.filter((layer) => layer.parent === undefined);
	if (roots.length !== 1) throw new Error(`app needs exactly one root layer; found ${roots.length}`);

	for (const layer of definition.layers) {
		if (layer.parent && !layers.has(layer.parent)) {
			throw new Error(`layer ${layer.id} has unknown parent ${layer.parent}`);
		}
		const visited = new Set<string>();
		let cursor: LayerDefinition | undefined = layer;
		while (cursor?.parent) {
			if (visited.has(cursor.id)) throw new Error(`layer cycle includes ${cursor.id}`);
			visited.add(cursor.id);
			cursor = layers.get(cursor.parent);
		}
	}

	for (const operation of definition.operations) {
		assertNonEmpty(operation.id, "operation id");
		if (!layers.has(operation.onLayer)) {
			throw new Error(`operation ${operation.id} has unknown layer ${operation.onLayer}`);
		}
	}

	return Object.freeze({ ...definition });
}

export function validateScope<Event>(definition: AppDefinition<Event>, scope: ScopePath): void {
	if (scope.length === 0) throw new Error("scope path must not be empty");
	const layers = new Map(definition.layers.map((layer) => [layer.id, layer]));

	for (let index = 0; index < scope.length; index++) {
		const ref = scope[index];
		const layer = layers.get(ref.layer);
		if (!layer) throw new Error(`scope references unknown layer ${ref.layer}`);
		if (ref.app !== definition.id) throw new Error(`scope app ${ref.app} does not match ${definition.id}`);
		assertNonEmpty(ref.id, `scope id for ${ref.layer}`);
		const expectedParent = index === 0 ? undefined : scope[index - 1].layer;
		if (layer.parent !== expectedParent) {
			throw new Error(
				`scope layer ${layer.id} expected parent ${layer.parent ?? "none"}, got ${expectedParent ?? "none"}`,
			);
		}
	}
}
