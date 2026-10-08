//! Browser bindings for one intersched room: an iroh-gossip topic plus a QR helper.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

use data_encoding::BASE64URL_NOPAD;
use iroh::{
    EndpointAddr, EndpointId, RelayUrl, SecretKey, address_lookup::MemoryLookup, endpoint::presets,
    protocol::Router,
};
use iroh_gossip::{
    api::{Event, GossipSender},
    net::{GOSSIP_ALPN, Gossip},
    proto::TopicId,
};
use js_sys::{Object, Reflect};
use n0_future::StreamExt;
use wasm_bindgen::prelude::*;
use wasm_streams::ReadableStream;

/// Room state is broadcast whole, so allow more than the 4 KiB default.
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
/// Peers named in a ticket. More peers make the QR code denser.
const TICKET_PEERS: usize = 3;

/// Peers we can name in a ticket. The relay URL lets a joiner dial a peer
/// before that peer's address reaches the n0 address lookup.
type Peers = BTreeMap<EndpointId, Option<RelayUrl>>;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Room {
    topic: TopicId,
    secret: SecretKey,
    me: Option<RelayUrl>,
    bootstrap: Peers,
    neighbors: Arc<Mutex<BTreeSet<EndpointId>>>,
    sender: GossipSender,
    events: Option<wasm_streams::readable::sys::ReadableStream>,
    _router: Router,
}

#[wasm_bindgen]
impl Room {
    /// Joins the room in `ticket`, or opens a new room when `ticket` is empty.
    /// `secret` is a base64url endpoint key from an earlier session, or empty for a new one.
    pub async fn open(ticket: String, secret: String) -> Result<Room, JsError> {
        let (topic, bootstrap) = if ticket.is_empty() {
            (TopicId::from_bytes(rand::random()), Peers::new())
        } else {
            decode_ticket(&ticket)?
        };
        let secret = match BASE64URL_NOPAD.decode(secret.as_bytes()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
            Some(bytes) => SecretKey::from_bytes(&bytes),
            None => SecretKey::generate(),
        };

        let endpoint = iroh::Endpoint::builder(presets::N0)
            .secret_key(secret.clone())
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .bind()
            .await
            .map_err(js_err)?;
        let known = MemoryLookup::new();
        for (id, relay) in &bootstrap {
            if let Some(relay) = relay {
                known.add_endpoint_info(EndpointAddr::new(*id).with_relay_url(relay.clone()));
            }
        }
        endpoint.address_lookup().map_err(js_err)?.add(known);
        // Our ticket must carry a relay URL, so wait until we have one.
        endpoint.online().await;
        let me = endpoint.addr().relay_urls().next().cloned();

        let gossip = Gossip::builder()
            .max_message_size(MAX_MESSAGE_SIZE)
            .spawn(endpoint.clone());
        let router = Router::builder(endpoint).accept(GOSSIP_ALPN, gossip.clone()).spawn();

        let my_id = secret.public();
        let peers: Vec<_> = bootstrap.keys().copied().filter(|id| *id != my_id).collect();
        let (sender, receiver) = gossip.subscribe(topic, peers).await.map_err(js_err)?.split();
        let neighbors = Arc::new(Mutex::new(BTreeSet::new()));
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
            topic,
            secret,
            me,
            bootstrap,
            neighbors,
            sender,
            events: Some(ReadableStream::from_stream(events).into_raw()),
            _router: router,
        })
    }

    /// A ReadableStream of `{ type: "up" | "down" | "msg" | "lagged", peers, data? }`.
    /// It can be taken once.
    pub fn events(&mut self) -> Option<wasm_streams::readable::sys::ReadableStream> {
        self.events.take()
    }

    /// A ticket to join this room, naming this endpoint and the peers it knows.
    pub fn ticket(&self) -> String {
        let mut peers = vec![(self.secret.public(), self.me.clone())];
        let neighbors = self.neighbors.lock().unwrap();
        // Prefer peers that are online now, then the ones we were invited by.
        peers.extend(neighbors.iter().map(|id| (*id, self.bootstrap.get(id).cloned().flatten())));
        peers.extend(self.bootstrap.iter().map(|(id, r)| (*id, r.clone())));
        let mut seen = BTreeSet::new();

        let mut bytes = self.topic.as_bytes().to_vec();
        for (id, relay) in peers.into_iter().filter(|(id, _)| seen.insert(*id)).take(TICKET_PEERS) {
            bytes.extend_from_slice(id.as_bytes());
            let relay = relay.map(|r| r.to_string()).unwrap_or_default();
            bytes.push(relay.len().min(255) as u8);
            bytes.extend_from_slice(&relay.as_bytes()[..relay.len().min(255)]);
        }
        BASE64URL_NOPAD.encode(&bytes)
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

/// An SVG QR code for `text`. Phone cameras read black on white with a quiet zone most reliably,
/// so it keeps those colours in dark mode too.
#[wasm_bindgen]
pub fn qr_svg(text: &str) -> Result<String, JsError> {
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).map_err(js_err)?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
}

/// A ticket is the topic, then per peer its 32-byte id, a length byte and its relay URL.
fn decode_ticket(ticket: &str) -> Result<(TopicId, Peers), JsError> {
    let damaged = || JsError::new("This invite link is damaged.");
    let bytes = BASE64URL_NOPAD.decode(ticket.as_bytes()).map_err(|_| damaged())?;
    let (topic, mut rest) = bytes.split_first_chunk::<32>().ok_or_else(damaged)?;
    let mut peers = Peers::new();
    while !rest.is_empty() {
        let (id, tail) = rest.split_first_chunk::<32>().ok_or_else(damaged)?;
        let (len, tail) = tail.split_first().ok_or_else(damaged)?;
        let (relay, tail) = tail.split_at_checked(*len as usize).ok_or_else(damaged)?;
        let id = EndpointId::from_bytes(id).map_err(|_| damaged())?;
        let relay = std::str::from_utf8(relay).ok().and_then(|r| r.parse::<RelayUrl>().ok());
        peers.insert(id, relay);
        rest = tail;
    }
    Ok((TopicId::from_bytes(*topic), peers))
}

fn js_err(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}
