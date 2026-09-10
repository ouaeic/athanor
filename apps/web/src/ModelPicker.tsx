import { lazy, Suspense, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ModelRelease, MediaModelOption } from '@athanor/contracts';
const ModelBrowser = lazy(() => import('./ModelBrowser.js'));

export type PickerModel = Pick<ModelRelease, 'id' | 'displayName' | 'provider'> &
  Partial<
    Pick<
      ModelRelease,
      | 'availability'
      | 'contextTokens'
      | 'modalities'
      | 'inputUsdPerMillionTokens'
      | 'outputUsdPerMillionTokens'
      | 'reasoning'
    >
  > & {
    capabilities?: ModelRelease['capabilities'] | MediaModelOption['capabilities'] | undefined;
    unavailableReason?: string | null | undefined;
    retirementAt?: string | undefined;
    usdPerImage?: number | null | undefined;
    usdPerMinute?: number | null | undefined;
    usdPerSecond?: number | null | undefined;
    usdPerMillionCharacters?: number | null | undefined;
  };
export interface ModelPickerProps {
  label: string;
  value: string;
  models: readonly PickerModel[];
  shortcuts?: { value: string; label: string; detail?: string }[];
  disabled?: boolean | undefined;
  loadDetails?: boolean;
  onChange: (value: string) => void;
}

export default function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const selected =
    props.shortcuts?.find((item) => item.value === props.value)?.label ??
    props.models.find((model) => model.id === props.value)?.displayName ??
    (props.value ? `${props.value} · unavailable` : 'Choose a model');
  return (
    <>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label={`${props.label}: ${selected}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        title={selected}
        onClick={() => setOpen(true)}
      >
        <span>{selected}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <Suspense fallback={<span role="status">Opening models…</span>}>
          <ModelBrowser
            {...props}
            onClose={() => setOpen(false)}
            onChange={(value) => {
              props.onChange(value);
              setOpen(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
