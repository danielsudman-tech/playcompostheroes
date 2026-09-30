/** Verified destinations for guests who want to continue after a game. */
export const PHYSICAL_GAME_URL = "https://www.compostheroes.org/purchase";
export const COMPOST_ASSESSMENT_URL = "https://www.compostheroes.org/assessment";
export const GREEN_CAMPS_URL = "https://www.greencamps.org/compost-heroes";

export const POST_GAME_LINKS = [
  {
    id: "physical-game",
    label: "Bring the card game home",
    description: "Find the physical Compost Heroes game.",
    href: PHYSICAL_GAME_URL,
    action: "See the game",
  },
  {
    id: "assessment",
    label: "Explore your compost solution",
    description: "Take the Compost Heroes solution assessment.",
    href: COMPOST_ASSESSMENT_URL,
    action: "Take the assessment",
  },
  {
    id: "green-camps",
    label: "Meet Green Camps",
    description: "See the work behind Compost Heroes.",
    href: GREEN_CAMPS_URL,
    action: "Visit Green Camps",
  },
] as const;