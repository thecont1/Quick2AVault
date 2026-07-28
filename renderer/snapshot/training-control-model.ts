export interface TrainingControlPresentation {
  active: boolean;
  ariaLabel: string;
  title: string;
}

export function trainingControlPresentation(on: boolean): TrainingControlPresentation {
  return {
    active: on,
    ariaLabel: on ? "Turn Training Mode off" : "Turn Training Mode on",
    title: on ? "Training Mode is on" : "Training Mode is off",
  };
}
