//! Browser bindings for one intersched room: an iroh-gossip topic plus a QR helper.
//!
//! A room is named by a few words. The words give the gossip topic and a signing key for a
//! record on the n0 pkarr relay. Every phone in the room lists itself in that record, so a
//! phone with only the words can find someone to join.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use data_encoding::BASE64URL_NOPAD;
use iroh::{
    EndpointAddr, EndpointId, RelayUrl, SecretKey,
    address_lookup::{MemoryLookup, pkarr::PkarrRelayClient},
    endpoint::presets,
    protocol::Router,
};
use iroh_dns::pkarr::SignedPacket;
use iroh_gossip::{
    api::{Event, GossipSender},
    net::{GOSSIP_ALPN, Gossip},
    proto::TopicId,
};
use js_sys::{Object, Reflect};
use n0_future::{
    StreamExt,
    task::{self, AbortOnDropHandle},
    time::{Duration, Instant, sleep, timeout},
};
use wasm_bindgen::prelude::*;
use wasm_streams::ReadableStream;

/// Room state is broadcast whole, so allow more than the 4 KiB default.
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
const PKARR_RELAY: &str = "https://dns.iroh.link/pkarr";
const RECORD_NAME: &str = "_intersched";
/// A pkarr packet holds at most 1000 bytes, and each entry takes about 100.
const RECORD_PEERS: usize = 6;
const RECORD_TTL: u32 = 300;
/// While alone, look for peers this often.
const ALONE_INTERVAL: Duration = Duration::from_secs(4);
/// While connected, refresh the record this often.
const REFRESH_INTERVAL: Duration = Duration::from_secs(120);

/// Peers we know of, with a relay URL when we have one. The relay URL lets us dial a peer
/// before its own address reaches the n0 address lookup.
type Peers = BTreeMap<EndpointId, Option<RelayUrl>>;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Room {
    secret: SecretKey,
    neighbors: Arc<Mutex<BTreeSet<EndpointId>>>,
    sender: GossipSender,
    events: Option<wasm_streams::readable::sys::ReadableStream>,
    _rendezvous: AbortOnDropHandle<()>,
    _router: Router,
}

#[wasm_bindgen]
impl Room {
    /// Joins the room named by `words`.
    /// `secret` is a base64url endpoint key from an earlier session, or empty for a new one.
    pub async fn open(words: String, secret: String) -> Result<Room, JsError> {
        let secret = match BASE64URL_NOPAD.decode(secret.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
            Some(bytes) => SecretKey::from_bytes(&bytes),
            None => SecretKey::generate(),
        };
        let topic = TopicId::from_bytes(blake3::derive_key("intersched 2026-10 topic", words.as_bytes()));
        let record_key = SecretKey::from_bytes(&blake3::derive_key("intersched 2026-10 record", words.as_bytes()));

        let endpoint = iroh::Endpoint::builder(presets::N0)
            .secret_key(secret.clone())
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .bind()
            .await
            .map_err(js_err)?;
        let lookup = MemoryLookup::new();
        endpoint.address_lookup().map_err(js_err)?.add(lookup.clone());
        // Our record entry must carry a relay URL, so wait until we have one.
        // A slow relay must not hang the room: carry on, and the relay connects in the background.
        timeout(Duration::from_secs(8), endpoint.online()).await.ok();
        let my_relay = endpoint.addr().relay_urls().next().cloned();

        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());
        let router = Router::builder(endpoint).accept(GOSSIP_ALPN, gossip.clone()).spawn();

        let record = Record { client: PkarrRelayClient::new(PKARR_RELAY.parse().unwrap()), key: record_key };
        let me = secret.public();
        let mut known = timeout(Duration::from_secs(6), record.read()).await.unwrap_or_default();
        known.remove(&me);
        seed(&lookup, &known);
        let (sender, receiver) = gossip
            .subscribe(topic, known.keys().copied().collect())
            .await
            .map_err(js_err)?
            .split();

        let neighbors = Arc::new(Mutex::new(BTreeSet::new()));
        let rendezvous = AbortOnDropHandle::new(task::spawn(rendezvous(
            record,
            lookup,
            sender.clone(),
            neighbors.clone(),
            (me, my_relay),
            known,
        )));

        let tracked = neighbors.clone();
        let events = receiver.filter_map(move |event| {
            let event = match event {
                Ok(event) => event,
                Err(err) => return Some(Err(JsValue::from_str(&err.to_string()))),
            };
            let obj = Object::new();
            let kind = match event {
                Event::NeighborUp(id) => {
                    tracked.lock().unwrap().insert(id);
                    "up"
                }
                Event::NeighborDown(id) => {
                    tracked.lock().unwrap().remove(&id);
                    "down"
                }
                Event::Received(msg) => {
                    let text = String::from_utf8_lossy(&msg.content).into_owned();
                    Reflect::set(&obj, &"data".into(), &text.into()).ok();
                    "msg"
                }
                Event::Lagged => "lagged",
            };
            Reflect::set(&obj, &"type".into(), &kind.into()).ok();
            Reflect::set(&obj, &"peers".into(), &(tracked.lock().unwrap().len() as u32).into()).ok();
            Some(Ok(obj.into()))
        });

        Ok(Room {
            secret,
            neighbors,
            sender,
            events: Some(ReadableStream::from_stream(events).into_raw()),
            _rendezvous: rendezvous,
            _router: router,
        })
    }

    /// A ReadableStream of `{ type: "up" | "down" | "msg" | "lagged", peers, data? }`.
    /// It can be taken once.
    pub fn events(&mut self) -> Option<wasm_streams::readable::sys::ReadableStream> {
        self.events.take()
    }

    /// The endpoint key, to rejoin with the same identity after a reload.
    pub fn secret(&self) -> String {
        BASE64URL_NOPAD.encode(&self.secret.to_bytes())
    }

    pub fn peers(&self) -> u32 {
        self.neighbors.lock().unwrap().len() as u32
    }

    pub async fn broadcast(&self, data: String) -> Result<(), JsError> {
        self.sender.broadcast(data.into_bytes().into()).await.map_err(js_err)
    }
}

/// The room's record on the pkarr relay: one TXT entry `<id> <relay url>` per phone.
struct Record {
    client: PkarrRelayClient,
    key: SecretKey,
}

impl Record {
    async fn read(&self) -> Peers {
        let Ok(packet) = self.client.resolve(self.key.public()).await else {
            return Peers::new();
        };
        packet
            .txt_records(RECORD_NAME)
            .iter()
            .filter_map(|entry| {
                let (id, relay) = entry.split_once(' ').unwrap_or((entry, ""));
                let id = <[u8; 32]>::try_from(BASE64URL_NOPAD.decode(id.as_bytes()).ok()?).ok()?;
                Some((EndpointId::from_bytes(&id).ok()?, relay.parse::<RelayUrl>().ok()))
            })
            .collect()
    }

    async fn write(&self, peers: &[(EndpointId, Option<RelayUrl>)]) {
        let entries = peers.iter().take(RECORD_PEERS).map(|(id, relay)| {
            let relay = relay.as_ref().map(|r| r.to_string()).unwrap_or_default();
            format!("{} {relay}", BASE64URL_NOPAD.encode(id.as_bytes()))
        });
        match SignedPacket::from_txt_strings(&self.key, RECORD_NAME, entries, RECORD_TTL) {
            Ok(packet) => {
                if let Err(err) = self.client.publish(&packet).await {
                    tracing::warn!("room record publish failed: {err}");
                }
            }
            Err(err) => tracing::warn!("room record too large: {err}"),
        }
    }
}

fn seed(lookup: &MemoryLookup, peers: &Peers) {
    for (id, relay) in peers {
        if let Some(relay) = relay {
            lookup.add_endpoint_info(EndpointAddr::new(*id).with_relay_url(relay.clone()));
        }
    }
}

/// Keeps this phone listed in the room record, and dials the listed phones while alone.
async fn rendezvous(
    record: Record,
    lookup: MemoryLookup,
    sender: GossipSender,
    neighbors: Arc<Mutex<BTreeSet<EndpointId>>>,
    me: (EndpointId, Option<RelayUrl>),
    mut known: Peers,
) {
    let mut written: Option<(Vec<EndpointId>, Instant)> = None;
    loop {
        let alone = neighbors.lock().unwrap().is_empty();
        if alone && written.is_some() {
            let mut fresh = timeout(Duration::from_secs(6), record.read()).await.unwrap_or_default();
            fresh.remove(&me.0);
            seed(&lookup, &fresh);
            let ids: Vec<_> = fresh.keys().copied().collect();
            if !ids.is_empty() {
                sender.join_peers(ids).await.ok();
            }
            known.extend(fresh);
        }

        // List us first, then the phones we are connected to, then the rest of the old record.
        let connected = neighbors.lock().unwrap().clone();
        let mut entries = vec![me.clone()];
        entries.extend(connected.iter().map(|id| (*id, known.get(id).cloned().flatten())));
        entries.extend(known.iter().filter(|(id, _)| !connected.contains(*id)).map(|(id, r)| (*id, r.clone())));
        let mut seen = BTreeSet::new();
        entries.retain(|(id, _)| seen.insert(*id));
        entries.truncate(RECORD_PEERS);

        let ids: Vec<_> = entries.iter().map(|(id, _)| *id).collect();
        let stale = match &written {
            None => true,
            Some((last, at)) => *last != ids || at.elapsed() > REFRESH_INTERVAL,
        };
        if stale {
            record.write(&entries).await;
            written = Some((ids, Instant::now()));
        }

        sleep(if alone { ALONE_INTERVAL } else { Duration::from_secs(15) }).await;
    }
}

/// The QR modules for `text`, row by row, 1 for dark. The page draws them itself.
#[wasm_bindgen]
pub fn qr_modules(text: &str) -> Result<Vec<u8>, JsError> {
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).map_err(js_err)?;
    Ok(code.to_colors().into_iter().map(|c| u8::from(c == qrcode::Color::Dark)).collect())
}

fn js_err(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}
