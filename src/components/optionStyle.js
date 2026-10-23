import { Circle, Diamond, Hexagon, Square, Star, Triangle } from 'lucide-react';

// Each option has a colour AND a shape so it is distinguishable without colour.
export const OPTION_STYLE = {
  A: { cls: 'opt-a', Icon: Diamond },
  B: { cls: 'opt-b', Icon: Circle },
  C: { cls: 'opt-c', Icon: Triangle },
  D: { cls: 'opt-d', Icon: Square },
  E: { cls: 'opt-e', Icon: Star },
  F: { cls: 'opt-f', Icon: Hexagon },
};
