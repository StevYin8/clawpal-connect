export interface ChannelConnectionSnapshot {
  providerConnected?: boolean;
  deliveryAvailable?: boolean;
  provider?: string;
  accountId?: string;
  detail?: string;
}
