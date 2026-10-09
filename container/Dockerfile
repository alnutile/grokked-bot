# The bot's computer: a real X desktop with a real branded Chrome on it.
#
# We launch Chrome ourselves and *attach* over CDP rather than letting Playwright
# launch it. That gets us Playwright's snapshot/locator/auto-wait engine AND a
# desktop a human can take over via VNC with a persistent profile -- instead of
# one or the other. It also leaves navigator.webdriver === false with no
# automation infobar, which matters on login pages.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    PROFILE_DIR=/data/profile/chrome \
    WORK_DIR=/data/work \
    CDP_PORT=9222 \
    SHIM_PORT=8088

# Mirrors and dl.google.com drop connections often enough on CI runners to fail
# a release; retry rather than restart a 30-minute build.
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify openbox xdotool xclip \
      tint2 xterm pcmanfm \
      x11-utils x11-xserver-utils dbus-x11 \
      supervisor tini ffmpeg \
      git gh jq \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Real Google Chrome, not the bundled unbranded Chromium: SSO risk engines treat
# unbranded builds as suspicious far more often, and the entire premise is
# signing into real accounts.
RUN for i in 1 2 3 4; do \
      npx -y playwright@1.62.1 install --with-deps chrome && break; \
      [ "$i" = 4 ] && exit 1; echo "chrome install failed, retrying ($i)"; sleep 20; \
    done \
    && rm -rf /root/.npm /tmp/*

WORKDIR /opt/shim
COPY shim/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY shim/src ./src

# Managed policy rather than --test-type: kills the "unsupported command-line
# flag" infobar (which eats 40px the model has to look past), pre-denies
# notification/geolocation prompts, and suppresses the save-password bubble and
# the Save-As dialog -- all native surfaces the CDP path cannot see.
RUN mkdir -p /etc/opt/chrome/policies/managed
COPY policies/grokked.json /etc/opt/chrome/policies/managed/grokked.json

COPY openbox/rc.xml /etc/xdg/openbox/rc.xml
COPY tint2rc /etc/xdg/tint2/tint2rc
COPY chrome-wrapper.sh /usr/local/bin/chrome-wrapper.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY supervisord.conf /etc/supervisor/conf.d/grokked.conf
RUN chmod +x /usr/local/bin/chrome-wrapper.sh /usr/local/bin/entrypoint.sh

# 9222 (CDP) is deliberately NOT exposed: it is unauthenticated and
# Network.getAllCookies over it drains every session in the profile.
EXPOSE 6080 8088

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
