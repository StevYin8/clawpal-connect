export interface QrPresentation {
    payload: string;
    terminal: string;
    dataUrl: string;
}
export declare function formatExpiryCountdown(expiresAtIso: string, now?: Date): string;
export declare class QrPresenter {
    present(payload: string): Promise<QrPresentation>;
}
