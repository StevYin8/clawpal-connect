import QRCode from "qrcode";
export function formatExpiryCountdown(expiresAtIso, now = new Date()) {
    const expiresAt = new Date(expiresAtIso).getTime();
    const seconds = Math.max(0, Math.floor((expiresAt - now.getTime()) / 1_000));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (seconds <= 0) {
        return "expired";
    }
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
export class QrPresenter {
    async present(payload) {
        const terminal = await QRCode.toString(payload, {
            type: "terminal",
            small: true
        });
        const dataUrl = await QRCode.toDataURL(payload, {
            width: 220,
            margin: 1
        });
        return { payload, terminal, dataUrl };
    }
}
//# sourceMappingURL=qr_presenter.js.map