/**
 * PSYBOSS Device Adapters — barrel export.
 *
 * All PSYBUS device adapters live here. Each adapter wraps an external
 * audio device and exposes it as a first-class PSYBUS participant.
 *
 * Available adapters:
 *   - DeviceAdapter (base class)
 *   - PsySynthProAdapter (browser DSP synthesizer)
 *   - PsyDrumAdapter (PsyDevice-conformant drum machine)
 *   - MidiAdapter (Web MIDI bridge)
 */

export { DeviceAdapter, type DeviceAdapterOptions, type AdapterTelemetry } from './device-adapter'
export { PsySynthProAdapter, createPsySynthProAdapter } from './psy-synth-pro-adapter'
export { PsyDrumAdapter, createPsyDrumAdapter } from './psy-drum-adapter'
export { MidiAdapter, createMidiAdapter, type MidiAdapterOptions } from './midi-adapter'
