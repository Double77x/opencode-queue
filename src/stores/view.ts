export type ViewState = {
  queueExpanded: boolean;
  stashedExpanded: boolean;
};

export const DEFAULT_VIEW: ViewState = {
  queueExpanded: true,
  stashedExpanded: false,
};
