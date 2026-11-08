// Controller input as an 8-bit mask per player per frame. This is deliberately the same
// shape lockstep multiplayer will send over the wire: one byte per player per frame.
import { Controller, type ButtonKey } from "jsnes";

export const BTN = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
} as const;

/** bit -> JSNES button id, in bit order */
export const JSNES_BUTTONS: ButtonKey[] = [
  Controller.BUTTON_A,
  Controller.BUTTON_B,
  Controller.BUTTON_SELECT,
  Controller.BUTTON_START,
  Controller.BUTTON_UP,
  Controller.BUTTON_DOWN,
  Controller.BUTTON_LEFT,
  Controller.BUTTON_RIGHT,
];

// Same defaults as EmulatorJS so muscle memory carries over.
const KEYMAP: Record<string, number> = {
  ArrowUp: BTN.UP,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  ArrowRight: BTN.RIGHT,
  KeyZ: BTN.A,
  KeyX: BTN.B,
  Enter: BTN.START,
  KeyV: BTN.SELECT,
  ShiftRight: BTN.SELECT,
};

export const KEY_HELP = "Arrows = D-pad · Z = A · X = B · Enter = Start · V = Select";

/** Keyboard + first connected gamepad -> one player's button mask. */
export class LocalInput {
  private keys = 0;
  private onKeyDown = (e: KeyboardEvent) => {
    const bit = KEYMAP[e.code];
    if (bit === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
    e.preventDefault(); // arrows/space would scroll the page
    this.keys |= bit;
  };
  private onKeyUp = (e: KeyboardEvent) => {
    const bit = KEYMAP[e.code];
    if (bit !== undefined) this.keys &= ~bit;
  };
  private onBlur = () => (this.keys = 0); // avoid stuck keys when focus leaves the frame
  gamepadName: string | null = null;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  read(): number {
    return this.keys | this.readGamepad();
  }

  private readGamepad(): number {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find((p): p is Gamepad => !!p && p.connected);
    this.gamepadName = gp?.id ?? null;
    if (!gp) return 0;
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    let m = 0;
    // "standard" mapping: 0 bottom, 1 right, 2 left, 3 top face buttons
    if (b(0) || b(1)) m |= BTN.A;
    if (b(2) || b(3)) m |= BTN.B;
    if (b(8)) m |= BTN.SELECT;
    if (b(9)) m |= BTN.START;
    if (b(12) || ay < -0.5) m |= BTN.UP;
    if (b(13) || ay > 0.5) m |= BTN.DOWN;
    if (b(14) || ax < -0.5) m |= BTN.LEFT;
    if (b(15) || ax > 0.5) m |= BTN.RIGHT;
    return m;
  }

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }
}
