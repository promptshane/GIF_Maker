import { Field } from '../common';
import { useStore } from '../../state/store';
import { TimeRangeField } from './TimeRangeField';

const EMOJI = [
  '😂', '😍', '🥹', '😎', '🤯', '🥳', '😭', '🤔',
  '🔥', '✨', '💥', '💯', '❤️', '👀', '👍', '🙌',
  '🎉', '⭐️', '🌈', '☀️', '🌙', '⚡️', '🍕', '☕️',
  '🐶', '🐱', '🦄', '🌸', '💀', '👻', '🤖', '🎈',
];

export function StickerPanel({
  playheadMs,
  durationMs,
}: {
  playheadMs: number;
  durationMs: number;
}) {
  const stickers = useStore((state) => state.stickers);
  const selectedId = useStore((state) => state.selectedOverlayId);
  const addSticker = useStore((state) => state.addSticker);
  const updateSticker = useStore((state) => state.updateSticker);
  const removeSticker = useStore((state) => state.removeSticker);
  const selectOverlay = useStore((state) => state.selectOverlay);

  const selected = stickers.find((sticker) => sticker.id === selectedId) ?? null;

  return (
    <>
      <Field label="Add emoji">
        <div className="emoji-grid">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => addSticker(emoji)}
              aria-label={`Add ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Field>

      {stickers.length === 0 ? (
        <div className="empty-note">
          Tap an emoji to place it. Then drag it on the preview, or pinch to resize and rotate.
        </div>
      ) : (
        <Field label="Placed" value={`${stickers.length}`}>
          {stickers.map((sticker, index) => (
            <div
              key={sticker.id}
              className={`list-card${sticker.id === selectedId ? ' selected' : ''}`}
            >
              <div className="list-card-head">
                <button
                  type="button"
                  onClick={() => selectOverlay(sticker.id)}
                  style={{ fontSize: 22 }}
                  aria-label={`Select emoji ${index + 1}`}
                >
                  {sticker.emoji}
                </button>
                <span className="title">Emoji {index + 1}</span>
                <button
                  type="button"
                  className="icon-btn danger"
                  style={{ flex: 'none', width: 72 }}
                  onClick={() => removeSticker(sticker.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </Field>
      )}

      {selected && (
        <>
          <Field label="Size" value={`${Math.round(selected.size * 100)}%`}>
            <input
              type="range"
              min={3}
              max={150}
              value={Math.round(selected.size * 100)}
              aria-label="Emoji size"
              onChange={(event) =>
                updateSticker(selected.id, { size: Number(event.target.value) / 100 })
              }
            />
          </Field>
          <Field label="Rotation" value={`${Math.round((selected.rotation * 180) / Math.PI)}°`}>
            <input
              type="range"
              min={-180}
              max={180}
              value={Math.round((selected.rotation * 180) / Math.PI)}
              aria-label="Emoji rotation"
              onChange={(event) =>
                updateSticker(selected.id, {
                  rotation: (Number(event.target.value) * Math.PI) / 180,
                })
              }
            />
          </Field>
          <TimeRangeField
            range={selected.range}
            durationMs={durationMs}
            playheadMs={playheadMs}
            onChange={(range) => updateSticker(selected.id, { range })}
          />
        </>
      )}
    </>
  );
}
