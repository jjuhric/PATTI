// A complete day in the free 3-hour forecast is 8 blocks. Fewer means the day is partial -
// which is always true for "today", since blocks earlier than now no longer exist. Deriving a
// daily high/low from a partial day silently reports the remaining hours as if they were the
// whole day (asking at 3pm reported the 3pm-midnight range as today's high/low), so partial
// days must be labeled rather than presented as a full-day summary.
const BLOCKS_PER_COMPLETE_DAY = 8;

function formatUnixTime(dt, timezone = 'America/Chicago', formatOptions = {}) {
  const date = new Date(dt * 1000);
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      ...formatOptions
    }).format(date);
  } catch (err) {
    // Fallback to America/Chicago if timezone string is invalid
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        ...formatOptions
      }).format(date);
    } catch (e) {
      return date.toUTCString();
    }
  }
}

async function handleWeatherTool(db, userId, action, params) {
  if (!db || !userId) {
    return 'Error: Database connection and User ID are required to run weather queries.';
  }

  // 1. Fetch user profile configurations
  let profile;
  try {
    profile = await db.get('SELECT zipcode, country, temp_unit, weather_api_key, timezone FROM users WHERE id = ?', [userId]);
  } catch (err) {
    console.error('Failed to query user profile for weather:', err.message);
    return `Error: Failed to query user profile details: ${err.message}`;
  }

  if (!profile || !profile.weather_api_key) {
    return 'Error: OpenWeatherMap API Key is not configured. Please open your user profile by clicking your avatar in the sidebar footer and save your API Key.';
  }

  const { decrypt } = require('../utils/crypto');
  const apiKey = decrypt(profile.weather_api_key);
  const units = profile.temp_unit || 'imperial';
  const unitSymbol = units === 'imperial' ? '°F' : (units === 'metric' ? '°C' : 'K');
  const speedUnit = units === 'imperial' ? 'mph' : 'm/s';
  const userTimezone = params?.timezone || profile?.timezone || 'America/Chicago';

  // Resolve target location parameters
  let lat = params?.lat;
  let lon = params?.lon;
  let cityName = params?.cityName;
  const zipcode = params?.zipcode || profile.zipcode;
  const country = params?.country || profile.country || 'US';

  // 2. Resolve Zipcode to Coordinates (lat/lon) via Geocoding API if not provided directly
  if (!lat || !lon) {
    if (!zipcode) {
      return 'Error: Zipcode is not configured and coordinates (lat/lon) were not provided.';
    }
    try {
      const geoUrl = `http://api.openweathermap.org/geo/1.0/zip?zip=${encodeURIComponent(zipcode)},${encodeURIComponent(country)}&appid=${apiKey}`;
      const geoRes = await fetch(geoUrl);
      if (!geoRes.ok) {
        throw new Error(`Geocoding failed with status ${geoRes.status}: ${geoRes.statusText}`);
      }
      const geoData = await geoRes.json();
      lat = geoData.lat;
      lon = geoData.lon;
      cityName = geoData.name;
    } catch (err) {
      console.error('Geocoding API failed:', err.message);
      return `Error: Failed to resolve coordinates for Zipcode ${zipcode}, Country ${country}. Please verify your API Key and Location details. Error details: ${err.message}`;
    }
  } else {
    cityName = cityName || `Coordinates (${lat}, ${lon})`;
  }

  // 3. Handle Actions
  if (action === 'geocode') {
    return JSON.stringify({
      success: true,
      cityName,
      zipcode,
      country,
      lat,
      lon,
      timezone: userTimezone
    }, null, 2);
  }

  else if (action === 'current') {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Current weather API returned status ${res.status}`);
      }
      const data = await res.json();

      const temp = data.main.temp;
      const feelsLike = data.main.feels_like;
      const minTemp = data.main.temp_min;
      const maxTemp = data.main.temp_max;
      const desc = data.weather[0].description;
      const humidity = data.main.humidity;
      const pressure = data.main.pressure;
      const windSpeed = data.wind.speed;
      const seaLevel = data.main.sea_level || 'N/A';
      const grndLevel = data.main.grnd_level || 'N/A';
      const rain1h = data.rain ? data.rain['1h'] || '0' : '0';

      const formattedReportTime = formatUnixTime(data.dt, userTimezone, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      const formattedSunrise = data.sys?.sunrise ? formatUnixTime(data.sys.sunrise, userTimezone, { hour: '2-digit', minute: '2-digit', hour12: true }) : 'N/A';
      const formattedSunset = data.sys?.sunset ? formatUnixTime(data.sys.sunset, userTimezone, { hour: '2-digit', minute: '2-digit', hour12: true }) : 'N/A';

      return `### 🌦️ Current Weather Report for **${cityName}** (${zipcode || 'N/A'}, ${country})
*Report Time: ${formattedReportTime} (Timezone: ${userTimezone})*

| Parameter | Value |
| --- | --- |
| **Current Weather** | ${desc.charAt(0).toUpperCase() + desc.slice(1)} |
| **Temperature** | ${temp}${unitSymbol} (Min: ${minTemp}${unitSymbol} / Max: ${maxTemp}${unitSymbol}) |
| **Feels Like** | ${feelsLike}${unitSymbol} |
| **Humidity** | ${humidity}% |
| **Pressure** | ${pressure} hPa (Sea Level: ${seaLevel} / Ground Level: ${grndLevel}) |
| **Wind Speed** | ${windSpeed} ${speedUnit} |
| **Rain (last 1h)** | ${rain1h} mm |
| **Sunrise** | ${formattedSunrise} |
| **Sunset** | ${formattedSunset} |
`;
    } catch (err) {
      return `Error: Failed to query current weather: ${err.message}`;
    }
  }

  else if (action === 'forecast_5day') {
    try {
      const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`5-day forecast API returned status ${res.status}`);
      }
      const data = await res.json();
      const list = data.list || [];

      let md = `### 📅 5-Day Forecast (3-Hour Increments) for **${cityName}**\n*Timezone: ${userTimezone}*\n\n`;
      md += `| Date & Time | Temp | Feels Like | Conditions | Humidity | Rain/Snow (3h) | Wind | Cloud Cover |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;

      list.forEach(item => {
        const formattedTime = formatUnixTime(item.dt, userTimezone, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        const temp = item.main.temp;
        const feelsLike = item.main.feels_like;
        const desc = item.weather[0].description;
        const humidity = item.main.humidity;
        const rain = item.rain ? `${item.rain['3h'] || 0} mm` : (item.snow ? `${item.snow['3h'] || 0} mm` : '0 mm');
        const wind = item.wind.speed;
        const clouds = item.clouds.all;

        md += `| ${formattedTime} | ${temp}${unitSymbol} | ${feelsLike}${unitSymbol} | ${desc} | ${humidity}% | ${rain} | ${wind} ${speedUnit} | ${clouds}% |\n`;
      });

      return md;
    } catch (err) {
      return `Error: Failed to fetch 5-day forecast: ${err.message}`;
    }
  }

  else if (action === 'hourly') {
    // 4-day hourly forecast or standard 5-day/3-hour fallback
    try {
      let res = null;
      let isTrueHourly = false;

      // The Pro hourly endpoint needs a paid subscription; fall back to the free 3-hour
      // forecast when it refuses.
      const proUrl = `https://pro.openweathermap.org/data/2.5/forecast/hourly?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
      res = await fetch(proUrl);
      if (res.ok) {
        isTrueHourly = true;
      } else {
        console.warn(`Hourly forecast (Pro) unavailable (status ${res.status}); using the free 3-hour forecast.`);
        res = null;
      }

      if (!res) {
        const fallbackUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
        res = await fetch(fallbackUrl);
        if (!res.ok) {
          throw new Error(`Standard forecast API failed: status ${res.status}`);
        }
      }

      const data = await res.json();
      const list = data.list || [];

      // The free endpoint returns 3-hour blocks, so 24 of them is 3 days - not the 24 hours
      // the heading used to promise. Take 8 blocks (24 hours) and say which granularity it is.
      const entriesWanted = isTrueHourly ? 24 : BLOCKS_PER_COMPLETE_DAY;
      const granularityNote = isTrueHourly ? 'hourly' : '3-hour intervals';

      let md = `### ⏰ Weather Forecast for **${cityName}** (Next 24 Hours, ${granularityNote})\n*Timezone: ${userTimezone}*\n\n`;
      md += `| Time | Temp | Feels Like | Weather | Rain % | Rain (1h) | Wind | Humidity |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;

      const entries = list.slice(0, entriesWanted);
      entries.forEach(item => {
        const formattedTime = formatUnixTime(item.dt, userTimezone, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        const temp = item.main.temp;
        const feelsLike = item.main.feels_like;
        const desc = item.weather[0].description;
        const pop = item.pop !== undefined ? `${(item.pop * 100).toFixed(0)}%` : '0%';
        const rain = item.rain ? item.rain['1h'] || item.rain['3h'] || '0' : '0';
        const wind = item.wind.speed;
        const humidity = item.main.humidity;

        md += `| ${formattedTime} | ${temp}${unitSymbol} | ${feelsLike}${unitSymbol} | ${desc} | ${pop} | ${rain} mm | ${wind} ${speedUnit} | ${humidity}% |\n`;
      });

      let alertsMd = '';
      if (country === 'US' || country === 'USA') {
        try {
          const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
          const alertsRes = await fetch(alertsUrl, {
            headers: {
              'User-Agent': 'PATTI/1.0 ([USER]@patti.assistant)'
            }
          });
          if (alertsRes.ok) {
            const alertsData = await alertsRes.json();
            const features = alertsData.features || [];
            if (features.length > 0) {
              alertsMd += `\n### ⚠️ ACTIVE WEATHER ALERTS (HIGHLY IMPORTANT)\n\n`;
              features.forEach(f => {
                const props = f.properties || {};
                alertsMd += `- **${props.event}** (${props.severity || 'Unknown Severity'})\n`;
                alertsMd += `  *Headline*: ${props.headline || 'No headline'}\n`;
                alertsMd += `  *Description*: ${props.description || 'No description'}\n\n`;
              });
            } else {
              alertsMd += `\n### ⚠️ ACTIVE WEATHER ALERTS\nNo active watches or warnings reported.\n`;
            }
          }
        } catch (alertsErr) {
          console.error('Failed to query weather.gov active alerts:', alertsErr.message);
          alertsMd += `\n### ⚠️ ACTIVE WEATHER ALERTS\n(Unable to retrieve alerts from weather.gov: ${alertsErr.message})\n`;
        }
      }

      return md + alertsMd;
    } catch (err) {
      return `Error: Failed to fetch hourly forecast: ${err.message}`;
    }
  }

  else if (action === 'daily') {
    // 16-day daily forecast or standard 5-day forecast averages
    const cnt = params?.cnt || 7;
    try {
      let res = null;
      let list = [];

      // forecast/daily needs a paid subscription; derive daily values from the free 5-day
      // 3-hour forecast when it refuses.
      const url = `https://api.openweathermap.org/data/2.5/forecast/daily?lat=${lat}&lon=${lon}&cnt=${cnt}&units=${units}&appid=${apiKey}`;
      res = await fetch(url);
      if (!res.ok) {
        console.warn(`Daily forecast endpoint unavailable (status ${res.status}); deriving daily values from the free 5-day forecast.`);
        res = null;
      }

      if (res) {
        const data = await res.json();
        list = data.list || [];
      } else {
        const fallbackUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
        const fallbackRes = await fetch(fallbackUrl);
        if (!fallbackRes.ok) {
          throw new Error(`5-day forecast fallback failed: status ${fallbackRes.status}`);
        }
        
        const fallbackData = await fallbackRes.json();
        const rawList = fallbackData.list || [];
        
        // Group by Day in target timezone
        const days = {};
        rawList.forEach(item => {
          const dateStr = formatUnixTime(item.dt, userTimezone, { year: 'numeric', month: 'numeric', day: 'numeric' });
          if (!days[dateStr]) {
            days[dateStr] = [];
          }
          days[dateStr].push(item);
        });

        // Compute daily averages
        Object.keys(days).slice(0, cnt).forEach(dateStr => {
          const points = days[dateStr];
          const temps = points.map(p => p.main.temp);
          const min = Math.min(...temps);
          const max = Math.max(...temps);
          const avgDay = temps.reduce((a, b) => a + b, 0) / temps.length;
          
          const middayPoint = points.find(p => {
            const hour = parseInt(formatUnixTime(p.dt, userTimezone, { hour: '2-digit', hour12: false }));
            return hour >= 11 && hour <= 14;
          }) || points[0];
          
          list.push({
            dt: middayPoint.dt,
            // "Today" only ever has the blocks that haven't happened yet, so its min/max
            // describe the remainder of the day, not the whole day. Flag it so the rendered
            // table can say so instead of reporting a wrong daily high.
            isPartialDay: points.length < BLOCKS_PER_COMPLETE_DAY,
            coverageFrom: points[0].dt,
            temp: {
              day: parseFloat(avgDay.toFixed(1)),
              min: parseFloat(min.toFixed(1)),
              max: parseFloat(max.toFixed(1)),
              night: parseFloat(points[points.length - 1].main.temp.toFixed(1)),
              morn: parseFloat(points[0].main.temp.toFixed(1))
            },
            humidity: parseFloat((points.reduce((a, b) => a + b.main.humidity, 0) / points.length).toFixed(0)),
            speed: parseFloat((points.reduce((a, b) => a + b.wind.speed, 0) / points.length).toFixed(1)),
            weather: middayPoint.weather,
            clouds: parseFloat((points.reduce((a, b) => a + b.clouds.all, 0) / points.length).toFixed(0)),
            rain: points.some(p => p.rain) ? parseFloat(points.reduce((a, b) => a + (b.rain ? b.rain['3h'] || 0 : 0), 0).toFixed(1)) : 0
          });
        });
      }

      let md = `### 📅 Daily Weather Forecast for **${cityName}** (Next ${list.length} Days)\n*Timezone: ${userTimezone}*\n\n`;
      md += `| Date | Temp (Day/Night) | Range (Min/Max) | Weather | Humidity | Wind | Rain |\n`;
      md += `| --- | --- | --- | --- | --- | --- | --- |\n`;

      let hasPartialDay = false;
      list.forEach(item => {
        let formattedDate = formatUnixTime(item.dt, userTimezone, { weekday: 'short', month: 'short', day: 'numeric' });
        if (item.isPartialDay) {
          hasPartialDay = true;
          const from = formatUnixTime(item.coverageFrom, userTimezone, { hour: '2-digit', minute: '2-digit', hour12: true });
          formattedDate += ` *(from ${from} only)*`;
        }
        const dayTemp = item.temp.day;
        const nightTemp = item.temp.night;
        const minTemp = item.temp.min;
        const maxTemp = item.temp.max;
        const desc = item.weather[0].description;
        const humidity = item.humidity;
        const speed = item.speed;
        const rain = item.rain || '0';

        md += `| ${formattedDate} | ${dayTemp}${unitSymbol} / ${nightTemp}${unitSymbol} | ${minTemp}${unitSymbol} - ${maxTemp}${unitSymbol} | ${desc} | ${humidity}% | ${speed} ${speedUnit} | ${rain} mm |\n`;
      });

      if (hasPartialDay) {
        md += `\n*Note: rows marked "(from ... only)" cover just the remaining part of that day, so their range is not the full-day high/low. For conditions right now, use the current-weather report instead.*\n`;
      }

      return md;
    } catch (err) {
      return `Error: Failed to fetch daily forecast: ${err.message}`;
    }
  }

  else if (action === 'onecall') {
    try {
      const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`One Call API returned status ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      
      const current = data.current || {};
      const currentTemp = current.temp;
      const feelsLike = current.feels_like;
      const humidity = current.humidity;
      const windSpeed = current.wind_speed;
      const weatherDesc = current.weather?.[0]?.description || 'N/A';
      
      const daily = data.daily || [];
      let dailyMd = `#### 📅 7-Day Forecast:\n`;
      daily.slice(0, 7).forEach(day => {
        const formattedDate = formatUnixTime(day.dt, userTimezone, { weekday: 'short', month: 'short', day: 'numeric' });
        const tempDay = day.temp?.day;
        const tempNight = day.temp?.night;
        const desc = day.weather?.[0]?.description || 'N/A';
        dailyMd += `- **${formattedDate}**: Day: ${tempDay}${unitSymbol}, Night: ${tempNight}${unitSymbol} - *${desc}*\n`;
      });

      return `### 🌦️ OpenWeatherMap One Call API Report for **${cityName}** (${zipcode || 'N/A'}, ${country})
- **Current Temperature**: ${currentTemp}${unitSymbol} (Feels like: ${feelsLike}${unitSymbol})
- **Conditions**: ${weatherDesc.charAt(0).toUpperCase() + weatherDesc.slice(1)}
- **Humidity**: ${humidity}%
- **Wind Speed**: ${windSpeed} ${speedUnit}
- **Timezone**: ${userTimezone}

${dailyMd}`;
    } catch (err) {
      console.error('One Call API failed:', err.message);
      return `Error: Failed to fetch One Call weather data: ${err.message}. (Ensure your API key is subscribed to One Call 3.0/4.0)`;
    }
  }

  return `Error: Unknown action "${action}" for weather tool.`;
}

module.exports = { handleWeatherTool };
