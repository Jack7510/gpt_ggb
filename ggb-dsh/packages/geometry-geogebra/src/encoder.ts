import {
  geoGebraCommandV1Schema,
  type GeoGebraArgumentV1,
  type GeoGebraCommandV1,
} from '@ggb-copilot/geometry-contract'

/** Encode one validated structured command at the GeoGebra API boundary. */
export function encodeGeoGebraCommandV1(input: unknown): string {
  const commandValue = geoGebraCommandV1Schema.parse(input)
  if (['LineEquation', 'ConicEquation', 'ImplicitCurveEquation'].includes(commandValue.name)) {
    return encodeEquation(commandValue)
  }
  const commandName = commandValue.name === 'PointOnObject' ? 'Point'
    : commandValue.name === 'ManualCommand' ? commandValue.manual!.command : commandValue.name
  const call = commandValue.name === 'Point'
    ? encodeGeoGebraCallV1('Point', [`{${commandValue.arguments.map(encodeArgument).join(',')}}`])
    : encodeGeoGebraCallV1(commandName, commandValue.arguments.map(encodeArgument))
  return commandValue.output === undefined ? call : `${encodeIdentifier(commandValue.output.label)}=${call}`
}

/** Render the exact GeoGebra identifiers used by the applet; captions live in command metadata. */
export function renderGeoGebraScriptV1(commands: readonly GeoGebraCommandV1[]): string {
  return commands.flatMap(command => {
    return command.manual?.resultOutputs === undefined
      ? [encodeGeoGebraCommandV1(command)] : encodeManualResultSetV1(command)
  }).join('\n')
}

/** Encode a native multi-result command as one List plus stable Element bindings. */
export function encodeManualResultSetV1(input: unknown): string[] {
  const command = geoGebraCommandV1Schema.parse(input)
  const outputs = command.manual?.resultOutputs
  if (command.name !== 'ManualCommand' || outputs === undefined || outputs.length < 2) {
    throw new Error('Manual result-set encoding requires multiple declared outputs.')
  }
  const listLabel = manualResultListLabel(command)
  const call = manualCall(command)
  return [`${encodeIdentifier(listLabel)}={${call}}`, ...outputs.map(output =>
    `${encodeIdentifier(output.label)}=${encodeGeoGebraCallV1('Element', [encodeIdentifier(listLabel), encodeNumber(output.index)])}`)]
}

/** Produce the internal List label shared by execution and displayed script. */
export function manualResultListLabel(command: GeoGebraCommandV1): string {
  return `ggbList${command.commandId.replaceAll('-', '').slice(-12)}`
}

/** Encode a command call from trusted, already encoded arguments, including nested probes.
 * This internal helper does not authorize commands or accept model expressions.
 */
export function encodeGeoGebraCallV1(name: string, arguments_: readonly string[]): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error('Unsafe GeoGebra command name.')
  return `${name}[${arguments_.join(',')}]`
}

function encodeArgument(argument: GeoGebraArgumentV1): string {
  if (argument.kind === 'object') return encodeIdentifier(argument.label)
  if (argument.kind === 'number') return encodeNumber(argument.value)
  if (argument.kind === 'boolean') return argument.value ? 'true' : 'false'
  if (argument.kind === 'expression') return argument.value
  return `"${argument.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function manualCall(command: GeoGebraCommandV1): string {
  if (command.manual === undefined) throw new Error('Manual command metadata is required.')
  return encodeGeoGebraCallV1(command.manual.command, command.arguments.map(encodeArgument))
}

function encodeEquation(command: GeoGebraCommandV1): string {
  const expression = command.arguments[0]
  if (command.output === undefined || command.arguments.length !== 1 || expression?.kind !== 'expression') {
    throw new Error('Equation command requires one expression and an output.')
  }
  return `${encodeIdentifier(command.output.label)}:${expression.value}`
}

function encodeIdentifier(value: string): string {
  if (value.length > 32 || !/^[A-Za-z][A-Za-z0-9_]*'*$/.test(value)) throw new Error('Unsafe GeoGebra identifier.')
  return value
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Unsafe GeoGebra number.')
  const encoded = Object.is(value, -0) ? '0' : String(value)
  if (!/^-?(?:\d+\.?\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(encoded)) throw new Error('Unsafe GeoGebra number.')
  return encoded
}
