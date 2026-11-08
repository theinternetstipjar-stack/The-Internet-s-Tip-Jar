const quotes = [
      "A little kindness can travel further than you think.",
      "Small beginnings still count as beginnings.",
      "Never underestimate the power of trying again.",
      "Your next chapter doesn't need permission to begin.",
      "Good things sometimes arrive in unexpected packages.",
      "Keep going. Even slow progress is progress.",
      "The world is better when we leave a little kindness behind.",
      "Somewhere, someone needs the encouragement you once needed.",
      "A little hope can make an ordinary day extraordinary.",
      "Don't let a difficult chapter convince you it's the whole story.",
      "The jar has no financial advice. It barely has financial literacy.",
      "Well, look at you, making questionable internet decisions.",
      "Your generosity has been noted by absolutely nobody important. But thank you!",
      "This jar is now emotionally invested in your success.",
      "The coins are getting along swimmingly.",
      "If coins could talk, this one would say hello.",
      "Your bank balance may have noticed your kindness.",
      "The jar would clap, but it has no hands.",
      "Somebody call the internet. We have a generous person.",
      "This is probably the most unusual thing you've done today.",
      "Behind this little jar is a story still being written.",
      "Some of the best things begin with a curious question.",
      "A stranger on one side. A stranger on the other. A little connection in between.",
      "Not every mystery needs solving.",
      "Somewhere in the world, the Keeper is smiling.",
      "The internet is full of strangers. Occasionally, that's a beautiful thing.",
      "One little coin. One unexpected moment.",
      "Perhaps kindness is the internet's best-kept secret.",
      "You found this jar for a reason. Or perhaps the algorithm has jokes.",
      "The Keeper knows very little about the internet. Except that it can be wonderful.",
      "Every big idea once looked a little ridiculous.",
      "Dream boldly. Start small. Keep showing up.",
      "The future is built from tiny decisions.",
      "Some adventures begin with a simple question.",
      "Never be embarrassed about wanting more from life.",
      "A little courage can change the direction of a whole journey.",
      "Big dreams don't always need big beginnings.",
      "Here's to the things we haven't achieved yet.",
      "The best stories often start unexpectedly.",
      "One day, you'll look back and smile at where it all began.",
      "The jar has been practising gratitude. Its financial planning still needs work.",
      "You've stumbled upon a jar with unrealistic ambitions. Relatable, isn't it?",
      "No pressure, but the jar has been making eyes at your spare change.",
      "The Keeper would like to remind you that scrolling is free. So is leaving. Just saying.",
      "This jar has more dreams than coins. At least we're consistent.",
      "The Keeper checked the balance. The optimism remains untouched.",
      "You came, you saw, you considered contributing. What a journey!",
      "The jar promises not to spend your contribution on tiny gold sunglasses. Probably.",
      "If curiosity paid rent, this website would be thriving.",
      "You don't need to have everything figured out to take the first step.",
      "Sometimes the smallest act becomes someone's favourite memory.",
      "Give yourself credit for the things nobody else sees.",
      "There is still room for wonderful things to happen.",
      "A little kindness is never a little thing.",
      "Don't underestimate what one brave decision can set in motion.",
      "You are allowed to begin again, as many times as you need.",
      "Even the longest journey is made of ordinary little steps.",
      "Let your dreams be bigger than your fear of looking silly.",
      "May you always find a reason to believe tomorrow can be better."
    ];

    const jar = document.getElementById("jar");
    const jarFill = document.getElementById("jarFill");
    const quoteElement = document.getElementById("quote");
    const paypalButton = document.getElementById("paypalButton");
    const paymentHint = document.getElementById("paymentHint");

    let previousQuoteIndex = -1;
    let coinCount = 0;
    let verifiedContributionCount = null;
    let progressRequestInFlight = false;

    // This endpoint must count only contributions verified by the PayPal webhook.
    const progressEndpoint = "/api/public/jar-progress";

    function chooseQuote() {
      if (quotes.length === 1) {
        return quotes[0];
      }

      let index;
      do {
        index = Math.floor(Math.random() * quotes.length);
      } while (index === previousQuoteIndex);

      previousQuoteIndex = index;
      return quotes[index];
    }

    function showVerifiedContribution() {
      const coin = document.createElement("span");
      coin.className = "coin";
      coin.textContent = "✦";
      jar.appendChild(coin);

      quoteElement.textContent = chooseQuote();
      for (let index = 0; index < 6; index += 1) {
        window.setTimeout(() => {
          const sparkle = document.createElement("span");
          sparkle.className = "sparkle";
          sparkle.textContent = "✦";
          sparkle.style.left = `${10 + Math.random() * 75}%`;
          sparkle.style.top = `${15 + Math.random() * 65}%`;
          jar.appendChild(sparkle);
          sparkle.addEventListener("animationend", () => sparkle.remove(), { once: true });
        }, index * 75);
      }

      coin.addEventListener("animationend", () => {
        coinCount += 1;

        // Leave each coin in the jar after it lands.
        const column = (coinCount - 1) % 3;
        const row = Math.floor((coinCount - 1) / 3);
        coin.style.animation = "none";
        coin.style.left = `${18 + column * 42}px`;
        coin.style.top = `${150 - row * 22}px`;
        coin.style.transform = "none";
      }, { once: true });
    }

    async function refreshJarProgress() {
      if (progressRequestInFlight) {
        return;
      }

      progressRequestInFlight = true;
      try {
        const response = await fetch(progressEndpoint, {
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!response.ok) {
          return;
        }

        const progress = await response.json();
        const count = progress.verifiedContributionCount;
        if (!Number.isSafeInteger(count) || count < 0) {
          return;
        }

        jarFill.style.height = `${Math.min(count * 4, 92)}%`;
        if (verifiedContributionCount !== null && count > verifiedContributionCount) {
          for (let index = verifiedContributionCount; index < count; index += 1) {
            showVerifiedContribution();
          }
        }
        verifiedContributionCount = count;
      } catch {
        // The progress endpoint may be unavailable when previewing this file locally.
      } finally {
        progressRequestInFlight = false;
      }
    }

    paypalButton.addEventListener("click", () => {
      paymentHint.textContent = "PayPal checkout opened in a new tab. The jar updates after verification.";
    });

    refreshJarProgress();
    window.setInterval(refreshJarProgress, 30000);
