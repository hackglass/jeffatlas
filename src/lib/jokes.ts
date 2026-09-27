/** Jeff's opening line. One is picked at random each time a conversation starts. */
export const RED_HAT_JOKES = [
  "Why does Red Hat never lose an argument? Because everything we do is open to discussion.",
  "I asked a Red Hatter how many people it takes to change a lightbulb. She said none, they just fork it and change it upstream.",
  "Red Hat's dress code is simple: any color you like, as long as it's a fedora.",
  "People ask why the hat is red. Honestly, it's from all the years of reading kernel patches.",
  "We tried a closed-door meeting once at Red Hat. Somebody filed a bug against the door.",
  "Why did the Red Hatter bring a ladder to standup? Somebody said the blocker was upstream.",
  "At Red Hat we don't have secrets. We have pull requests that haven't been reviewed yet.",
  "I told a new hire our roadmap is public. He said, great, where is it. I said, it's in the commit history, like everything else.",
  "Why are Red Hatters so calm during outages? Twenty years of Linux taught us to just read the logs.",
  "Someone asked if Red Hat has a hardware team. I said sure, we make hats.",
  "What's a Red Hatter's favorite Boston sport? Rebasing.",
  "Red Hat's motto is 'open source everything.' Except the coffee machine. That's the one thing we lock down.",
];

export function pickJoke(): string {
  return RED_HAT_JOKES[Math.floor(Math.random() * RED_HAT_JOKES.length)];
}
