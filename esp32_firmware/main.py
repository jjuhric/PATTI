import network
import machine
import ubinascii
import json
import time
import sys
# Try importing ESP32 internal temp module
try:
    import esp32
except ImportError:
    esp32 = None

# Try importing umqtt.simple
try:
    from umqtt.simple import MQTTClient
except ImportError:
    # Minimal fallback MQTT client mock/stub for compilation safety
    class MQTTClient:
        def __init__(self, *args, **kwargs): pass
        def connect(self): pass
        def publish(self, *args, **kwargs): pass
        def subscribe(self, *args, **kwargs): pass
        def set_callback(self, *args): pass
        def check_msg(self): pass

WIFI_SSID = "your-wifi-name"
WIFI_PASS = "your-wifi-password"
MQTT_BROKER = "192.168.1.42" # Fallback Main Host IP address
MQTT_PORT = 1883
# SEC-7 (docs/REVIEW_2026-08-03.md): leave both blank if the broker still allows anonymous
# connections. Once broker auth is enabled (see backend/scripts/enable_mqtt_auth.ps1), set
# these to match the username/password configured there before reflashing.
MQTT_USER = ""
MQTT_PASS = ""

# Generate deterministic node ID from hardware unique ID
node_id = "esp32_" + ubinascii.hexlify(machine.unique_id()).decode()

def connect_wifi(ssid, password):
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print('Connecting to WiFi network...')
        wlan.connect(ssid, password)
        # Timeout after 15 seconds
        start = time.time()
        while not wlan.isconnected() and time.time() - start < 15:
            time.sleep(1)
            print('.', end='')
    print('\nNetwork config:', wlan.ifconfig())
    return wlan.ifconfig()[0] if wlan.isconnected() else '0.0.0.0'

def read_temperature():
    if esp32:
        try:
            # esp32.raw_temperature() returns Fahrenheit on older MicroPython, Celsius on newer
            tf = esp32.raw_temperature()
            tc = (tf - 32) * 5 / 9 if tf > 80 else tf
            return round(tc, 1)
        except Exception:
            pass
    return "Unavailable"

def read_power():
    # Attempt I2C query to INA219 at 0x41
    try:
        i2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21))
        addr = 0x41
        # Test if address responds
        if addr in i2c.scan():
            # INA219 minimal read bus voltage (register 0x02)
            reg_volt = i2c.readfrom_mem(addr, 0x02, 2)
            raw_volt = (reg_volt[0] * 256) + reg_volt[1]
            voltage = (raw_volt >> 3) * 0.004
            
            # Simple battery percentage math
            battery_percent = ((voltage - 9.0) / 3.6) * 100
            battery_percent = max(0.0, min(100.0, battery_percent))
            
            return {
                "voltage_v": round(voltage, 3),
                "power_w": "Unavailable",
                "battery_percent": round(battery_percent, 1)
            }
    except Exception:
        pass
    return "Unavailable"

def publish_response(request_id, status, data):
    response_topic = "nodes/{}/responses".format(node_id)
    response_payload = json.dumps({
        "requestId": request_id,
        "status": status,
        "data": data
    })
    try:
        mqtt_client.publish(response_topic, response_payload)
        print("Published response to:", response_topic)
    except Exception as e:
        print("Failed to publish MQTT response:", e)

def handle_get_system_info(request_id, payload):
    wlan = network.WLAN(network.STA_IF)
    local_ip = wlan.ifconfig()[0] if wlan.isconnected() else "0.0.0.0"

    response_data = {
        "node_id": node_id,
        "ip_address": local_ip,
        "os": "MicroPython " + sys.version,
        "timezone": "UTC",
        "timestamp": "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(*time.gmtime()[:6]),
        "temperature": read_temperature(),
        "power": read_power()
    }
    publish_response(request_id, "success", response_data)

def handle_send_message(request_id, payload):
    # No display driver exists in this firmware (the ESP32-CYD's TFT panel is never
    # initialized here), so the honest, always-correct behavior on any board is to log
    # the message to the serial console rather than silently pretending to render it.
    message = payload.get("message", "")
    print("[ESP32 Message]:", message)
    publish_response(request_id, "success", {
        "success": True,
        "displayed": False,
        "note": "Message logged to serial console. On-screen display requires board-specific driver code not yet implemented."
    })

def handle_unimplemented(command, request_id, payload):
    print("Received unimplemented command:", command)
    publish_response(request_id, "error", {
        "error": "Command '{}' is not implemented on this firmware.".format(command)
    })

COMMAND_HANDLERS = {
    "get_system_info": handle_get_system_info,
    "send_message": handle_send_message
}

def mqtt_callback(topic, msg):
    print("Received MQTT message on topic:", topic.decode())
    try:
        payload = json.loads(msg.decode())
    except Exception:
        print("Failed to decode JSON payload.")
        return

    command = payload.get("command")
    request_id = payload.get("requestId")
    handler = COMMAND_HANDLERS.get(command)
    if handler:
        handler(request_id, payload)
    else:
        handle_unimplemented(command, request_id, payload)

def main():
    global mqtt_client
    print("Starting ESP32 Edge Node Client:", node_id)
    
    # Connect WiFi
    ip = connect_wifi(WIFI_SSID, WIFI_PASS)
    if ip == '0.0.0.0':
        print("WiFi Connection Failed. Running in offline/stub mode.")
        return

    # Connect MQTT Broker
    try:
        mqtt_client = MQTTClient(
            node_id, MQTT_BROKER, port=MQTT_PORT,
            user=MQTT_USER if MQTT_USER else None,
            password=MQTT_PASS if MQTT_PASS else None
        )
        mqtt_client.set_callback(mqtt_callback)
        mqtt_client.connect()
        print("Connected to MQTT Broker at:", MQTT_BROKER)
        
        command_topic = "nodes/{}/commands".format(node_id)
        mqtt_client.subscribe(command_topic)
        print("Subscribed to command topic:", command_topic)

        # Loop forever listening for commands
        while True:
            mqtt_client.check_msg()
            time.sleep(0.5)
            
    except Exception as e:
        print("MQTT Client connection error:", e)

if __name__ == '__main__':
    main()
