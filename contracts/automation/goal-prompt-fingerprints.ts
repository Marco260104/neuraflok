export interface GoalPromptFingerprints {
  system: readonly string[];
  objective: readonly string[];
  loop: readonly string[];
}

export const GOAL_PROMPT_FINGERPRINTS: GoalPromptFingerprints = {
  system: [
    '7c3bcf5c1cbb3060460e70435ef41c6b7d9165768d59cbed850d03b84260cd0e',
    '8d9da84f334a98c0ee3274d4bcd26c8495ba8c717c972799b827306b90777669',
    '78d35773efa9bc28db51fa92f61f17880958a4f91e806af504950f38fb2724b3'
  ],
  objective: [
    '10d0681afc05e19a90d91dfdb85719d383e6b5d067f94cf93ea76fd90619eae4',
    'fe41890bff7cd80a27536e6a91d39b8cf50520edee13c7a223baf9bc52c3dd30'
  ],
  loop: [
    '69bfe75c2c3c406aa419ccc0ed93a4811d301f6e62ddf48db90e1a40f04e3c09',
    '134805175df865d62df8867119456fa5bc66df25038b7ee3c36561e2d7d469ca',
    '9e8ec0961cb6ad403b14a2687c7b6bd155413eb48e7c8049478d95619fb5c871'
  ]
};
